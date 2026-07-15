import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";

import {
  loadBundledMigrationsFromDisk,
  loadBundledSemanticMigrationsFromDisk,
} from "../migrations-fs.js";
import { applyMigrations } from "../migrations.js";
import { resolveWorkspaceTargets } from "../workspace-targets.js";

export type AnchorClawSetupOptions = {
  adminUrl?: string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  rotateDbPassword?: boolean;
  schema?: string;
  maintenanceWorkspaceScope?: "default-agent" | "all-agent-workspaces";
  semanticEnabled?: boolean;
  semanticProvider?: string;
  semanticModel?: string;
  semanticBaseUrl?: string;
  semanticApiKey?: string;
  schemaNone?: boolean;
  skipConfig?: boolean;
  nonInteractive?: boolean;
};

type MaintenanceWorkspaceScopeConfig =
  | { mode: "default-agent" }
  | { mode: "all-agent-workspaces" }
  | { mode: "agents"; agents: string[] };

type ResolvedSetupOptions = {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  rotateDbPassword: boolean;
  schema: string | undefined;
  maintenanceWorkspaceScope?: MaintenanceWorkspaceScopeConfig;
  maintenanceEnabled: boolean;
  extractorEnabled: boolean;
  semanticConfigEnabled?: boolean;
  semanticResolvedEnabled: boolean;
  semanticProvider?: string;
  semanticModel?: string;
  semanticBaseUrl?: string;
  semanticApiKey?: string;
  semanticApiKeyConfigured: boolean;
  skipConfig: boolean;
  nonInteractive: boolean;
};

type PromptInjectionConfigState = "enabled" | "disabled" | "unset";
type SessionMemoryHookConfigState = "enabled" | "disabled" | "unset";
type ExistingMemorySearchDefaults = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyConfigured: boolean;
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DATABASE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function validateIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  if (!IDENTIFIER_RE.test(trimmed)) {
    throw new Error(`${label} must be a simple identifier (letters/numbers/underscore)`);
  }
  return trimmed;
}

function validateDatabaseName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("db-name must be non-empty");
  }
  if (!DATABASE_NAME_RE.test(trimmed)) {
    throw new Error("db-name must contain only letters, numbers, underscores, or hyphens");
  }
  return trimmed;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function generatePassword(length = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

function normalizeEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function normalizeOptionalInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveSafeOsHomedir(): string | undefined {
  try {
    return normalizeEnvPath(homedir());
  } catch {
    return undefined;
  }
}

function resolveOsHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeEnvPath(env.HOME) ?? normalizeEnvPath(env.USERPROFILE) ?? resolveSafeOsHomedir();
}

function resolveOpenClawHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitHome = normalizeEnvPath(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveOsHomeDir(env);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const osHome = resolveOsHomeDir(env);
    return osHome ? explicitHome.replace(/^~(?=$|[\\/])/, osHome) : undefined;
  }
  return explicitHome;
}

function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = normalizeEnvPath(env.OPENCLAW_CONFIG_PATH);
  if (explicitPath) {
    return resolve(explicitPath);
  }
  const explicitDir = normalizeEnvPath(env.OPENCLAW_CONFIG_DIR);
  if (explicitDir) {
    return resolve(explicitDir, "openclaw.json");
  }
  const home = resolveOpenClawHomeDir(env) ?? ".";
  return resolve(home, ".openclaw", "openclaw.json");
}

function normalizeMaintenanceWorkspaceScopeMode(
  value: string | undefined,
): "default-agent" | "all-agent-workspaces" | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "default-agent" || trimmed === "all-agent-workspaces") {
    return trimmed;
  }
  throw new Error(
    'maintenance-workspace-scope must be "default-agent" or "all-agent-workspaces"',
  );
}

function scopeConfigFromMode(mode: "default-agent" | "all-agent-workspaces"): MaintenanceWorkspaceScopeConfig {
  return { mode };
}

function readOpenClawConfigRecord(): Record<string, any> | undefined {
  const cfgPath = resolveOpenClawConfigPath();
  if (!existsSync(cfgPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, any>;
}

function normalizeAgentIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const agentIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    agentIds.push(trimmed);
  }
  return agentIds.length > 0 ? agentIds : undefined;
}

function readExistingMaintenanceWorkspaceScope(
  cfg: Record<string, any> | undefined,
): MaintenanceWorkspaceScopeConfig | undefined {
  const scope = cfg?.plugins?.entries?.anchorclaw?.config?.maintenance?.workspaceScope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return undefined;
  }
  const mode = typeof (scope as Record<string, any>).mode === "string"
    ? (scope as Record<string, any>).mode.trim()
    : "";
  if (mode === "default-agent" || mode === "all-agent-workspaces") {
    return { mode };
  }
  if (mode === "agents") {
    const agentIds = normalizeAgentIdList((scope as Record<string, any>).agents);
    return agentIds ? { mode, agents: agentIds } : undefined;
  }
  return undefined;
}

function readExistingSemanticEnabled(cfg: Record<string, any> | undefined): boolean {
  return cfg?.plugins?.entries?.anchorclaw?.config?.semantic?.enabled === true;
}

function readExistingDefaultsMemorySearch(
  cfg: Record<string, any> | undefined,
): ExistingMemorySearchDefaults {
  const memorySearch = asRecord(cfg?.agents?.defaults?.memorySearch);
  const remote = asRecord(memorySearch.remote);
  return {
    provider: typeof memorySearch.provider === "string" && memorySearch.provider.trim()
      ? memorySearch.provider.trim()
      : undefined,
    model: typeof memorySearch.model === "string" && memorySearch.model.trim()
      ? memorySearch.model.trim()
      : undefined,
    baseUrl: typeof remote.baseUrl === "string" && remote.baseUrl.trim()
      ? remote.baseUrl.trim()
      : undefined,
    apiKeyConfigured: Object.prototype.hasOwnProperty.call(remote, "apiKey"),
  };
}

function formatMaintenanceWorkspaceScope(scope: MaintenanceWorkspaceScopeConfig | undefined): string | undefined {
  if (!scope) {
    return undefined;
  }
  if (scope.mode === "agents") {
    return `agents (${scope.agents.join(", ")})`;
  }
  return scope.mode;
}

type MaintenanceScopePromptChoice = {
  label: string;
  detail: string;
  maintenanceEnabled: boolean;
  extractorEnabled: boolean;
  scope?: MaintenanceWorkspaceScopeConfig;
};

function dedupeMaintenanceScopeChoices(
  choices: MaintenanceScopePromptChoice[],
): MaintenanceScopePromptChoice[] {
  const seen = new Set<string>();
  const deduped: MaintenanceScopePromptChoice[] = [];
  for (const choice of choices) {
    const key = JSON.stringify({
      extractorEnabled: choice.extractorEnabled,
      scope: choice.scope ?? null,
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(choice);
  }
  return deduped;
}

function buildMaintenanceScopePromptChoices(params: {
  existingScope?: MaintenanceWorkspaceScopeConfig;
  openClawConfig?: Record<string, any>;
}): MaintenanceScopePromptChoice[] {
  const choices: MaintenanceScopePromptChoice[] = [];
  if (params.existingScope) {
    choices.push({
      label: `keep current scope (${formatMaintenanceWorkspaceScope(params.existingScope)})`,
      detail: "Preserve the existing maintenance.workspaceScope setting.",
      maintenanceEnabled: true,
      extractorEnabled: true,
      scope: params.existingScope,
    });
  }

  let defaultWorkspaceDetail = "OpenClaw default agent workspace";
  let allWorkspaceDetail: string | undefined;

  if (params.openClawConfig) {
    try {
      const [defaultTarget] = resolveWorkspaceTargets({
        runtimeConfig: params.openClawConfig as any,
        selector: { mode: "default-agent" },
      });
      defaultWorkspaceDetail = defaultTarget.workspaceDir;
      const allTargets = resolveWorkspaceTargets({
        runtimeConfig: params.openClawConfig as any,
        selector: { mode: "all-agent-workspaces" },
      });
      if (allTargets.length > 1) {
        allWorkspaceDetail = allTargets
          .map((target) => `${target.label} -> ${target.workspaceDir}`)
          .join(" | ");
      }
    } catch {
      // Keep fallback labels if config cannot be resolved during setup prompting.
    }
  }

  choices.push({
    label: "default agent workspace",
    detail: defaultWorkspaceDetail,
    maintenanceEnabled: true,
    extractorEnabled: true,
    scope: { mode: "default-agent" },
  });

  if (allWorkspaceDetail) {
    choices.push({
      label: "all agent workspaces",
      detail: allWorkspaceDetail,
      maintenanceEnabled: true,
      extractorEnabled: true,
      scope: { mode: "all-agent-workspaces" },
    });
  }

  choices.push({
    label: "disable maintenance",
    detail: "Do not start the background maintenance scheduler yet.",
    maintenanceEnabled: false,
    extractorEnabled: false,
  });

  return dedupeMaintenanceScopeChoices(choices);
}

async function promptForMaintenanceWorkspaceScope(params: {
  rl: ReturnType<typeof createInterface>;
  existingScope?: MaintenanceWorkspaceScopeConfig;
  openClawConfig?: Record<string, any>;
}): Promise<{
  maintenanceEnabled: boolean;
  extractorEnabled: boolean;
  maintenanceWorkspaceScope?: MaintenanceWorkspaceScopeConfig;
}> {
  const choices = buildMaintenanceScopePromptChoices(params);
  const defaultChoice = choices[0];

  console.log("\nSelect maintenance extractor workspace scope:");
  for (const [index, choice] of choices.entries()) {
    console.log(`${index + 1}. ${choice.label} -> ${choice.detail}`);
  }

  while (true) {
    const answer = (await params.rl.question("Choice [1]: ")).trim();
    if (!answer) {
      return {
        maintenanceEnabled: defaultChoice!.maintenanceEnabled,
        extractorEnabled: defaultChoice!.extractorEnabled,
        maintenanceWorkspaceScope: defaultChoice!.scope,
      };
    }
    const selected = Number.parseInt(answer, 10);
    if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
      const choice = choices[selected - 1]!;
      return {
        maintenanceEnabled: choice.maintenanceEnabled,
        extractorEnabled: choice.extractorEnabled,
        maintenanceWorkspaceScope: choice.scope,
      };
    }
    console.warn(`Invalid selection: ${JSON.stringify(answer)}. Enter a number from 1 to ${choices.length}.`);
  }
}

function ensureNonInteractiveMaintenanceScopeDecision(params: {
  skipConfig: boolean;
  maintenanceWorkspaceScopeMode?: "default-agent" | "all-agent-workspaces";
  existingScope?: MaintenanceWorkspaceScopeConfig;
}): MaintenanceWorkspaceScopeConfig | undefined {
  if (params.skipConfig) {
    return undefined;
  }
  if (params.maintenanceWorkspaceScopeMode) {
    return scopeConfigFromMode(params.maintenanceWorkspaceScopeMode);
  }
  if (params.existingScope) {
    return params.existingScope;
  }
  throw new Error(
    'maintenance workspace scope is required for non-interactive setup because setup enables extractor by default; pass --maintenance-workspace-scope "default-agent" or "all-agent-workspaces", preconfigure maintenance.workspaceScope, or use --skip-config',
  );
}

function readPromptInjectionConfigState(cfg: Record<string, any>): PromptInjectionConfigState {
  const hooks = cfg.plugins?.entries?.anchorclaw?.hooks;
  if (!hooks || typeof hooks !== "object") {
    return "unset";
  }
  if (hooks.allowPromptInjection === false) {
    return "disabled";
  }
  if (hooks.allowPromptInjection === true) {
    return "enabled";
  }
  return "unset";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function readSessionMemoryHookConfigState(cfg: Record<string, any>): SessionMemoryHookConfigState {
  const entry = cfg.hooks?.internal?.entries?.["session-memory"];
  if (!entry || typeof entry !== "object") {
    return "unset";
  }
  if ((entry as Record<string, any>).enabled === false) {
    return "disabled";
  }
  if ((entry as Record<string, any>).enabled === true) {
    return "enabled";
  }
  return "unset";
}

async function promptIfNeeded(params: {
  options: AnchorClawSetupOptions;
}): Promise<ResolvedSetupOptions> {
  const defaults = {
    adminUrl: "postgres://localhost/postgres",
    dbName: "anchorclaw",
    dbUser: "anchorclaw",
    schema: "memory",
  };
  const nonInteractive = Boolean(params.options.nonInteractive);
  const skipConfig = Boolean(params.options.skipConfig);
  let rotateDbPassword = Boolean(params.options.rotateDbPassword);
  const maintenanceWorkspaceScopeMode = normalizeMaintenanceWorkspaceScopeMode(
    params.options.maintenanceWorkspaceScope,
  );
  const existingConfig = readOpenClawConfigRecord();
  const existingMaintenanceWorkspaceScope = readExistingMaintenanceWorkspaceScope(existingConfig);
  const existingSemanticEnabled = readExistingSemanticEnabled(existingConfig);
  const existingMemorySearchDefaults = readExistingDefaultsMemorySearch(existingConfig);
  let maintenanceEnabled = !skipConfig;
  let extractorEnabled = !skipConfig;
  let maintenanceWorkspaceScope = maintenanceWorkspaceScopeMode
    ? scopeConfigFromMode(maintenanceWorkspaceScopeMode)
    : undefined;
  let semanticConfigEnabled: boolean | undefined;
  let semanticResolvedEnabled = existingSemanticEnabled;
  let semanticProvider = normalizeOptionalInput(params.options.semanticProvider);
  let semanticModel = normalizeOptionalInput(params.options.semanticModel);
  let semanticBaseUrl = normalizeOptionalInput(params.options.semanticBaseUrl);
  let semanticApiKey = normalizeOptionalInput(params.options.semanticApiKey);

  let adminUrl = params.options.adminUrl?.trim() || defaults.adminUrl;
  let dbName = params.options.dbName?.trim() || defaults.dbName;
  let dbUser = params.options.dbUser?.trim() || defaults.dbUser;
  let schema: string | undefined;

  if (params.options.schemaNone) {
    schema = undefined;
  } else if (typeof params.options.schema === "string") {
    const rawSchema = params.options.schema.trim();
    schema = rawSchema.toLowerCase() === "none" || rawSchema === "" ? undefined : rawSchema;
  } else {
    schema = defaults.schema;
  }

  let dbPassword = params.options.dbPassword?.trim() || "";

  const semanticFlagsProvided =
    params.options.semanticEnabled === true ||
    typeof semanticProvider === "string" ||
    typeof semanticModel === "string" ||
    typeof semanticBaseUrl === "string" ||
    typeof semanticApiKey === "string";

  if (skipConfig && semanticFlagsProvided) {
    throw new Error("semantic setup options require config update; remove semantic flags or omit --skip-config");
  }

  if (!nonInteractive) {
    const rl = createInterface({ input, output });
    try {
      const adminAnswer = (await rl.question(`Postgres admin URL [${adminUrl}]: `)).trim();
      if (adminAnswer) adminUrl = adminAnswer;

      const dbNameAnswer = (await rl.question(`Database name [${dbName}]: `)).trim();
      if (dbNameAnswer) dbName = dbNameAnswer;

      const dbUserAnswer = (await rl.question(`App user [${dbUser}]: `)).trim();
      if (dbUserAnswer) dbUser = dbUserAnswer;

      const schemaDefault = schema ?? "none";
      const schemaAnswer = (
        await rl.question(
          `Schema [${schemaDefault}] (type "none" to use default search_path/public): `,
        )
      ).trim();
      if (schemaAnswer) {
        schema = schemaAnswer.toLowerCase() === "none" ? undefined : schemaAnswer;
      }

      const passwordAnswer = (await rl.question("App password [auto-generate]: ")).trim();
      if (passwordAnswer) {
        dbPassword = passwordAnswer;
      }
      const shouldUpdateByDefault = !skipConfig;
      const updateAnswer = (await rl.question(`Update openclaw.json? [${shouldUpdateByDefault ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      const update = updateAnswer
        ? !["n", "no"].includes(updateAnswer)
        : shouldUpdateByDefault;
      params.options.skipConfig = !update;

      if (!params.options.skipConfig) {
        const semanticDefault = existingSemanticEnabled ? "Y/n" : "y/N";
        const semanticAnswer = (
          await rl.question(`Enable AnchorClaw semantic layer? [${semanticDefault}]: `)
        )
          .trim()
          .toLowerCase();
        const semanticEnabled = semanticAnswer
          ? ["y", "yes"].includes(semanticAnswer)
          : existingSemanticEnabled;
        semanticResolvedEnabled = semanticEnabled;
        if (semanticEnabled) {
          semanticConfigEnabled = true;
          const providerDefault = semanticProvider ?? existingMemorySearchDefaults.provider ?? "";
          const providerAnswer = (
            await rl.question(
              `Semantic provider${providerDefault ? ` [${providerDefault}]` : ""}: `,
            )
          ).trim();
          semanticProvider = providerAnswer || providerDefault || undefined;

          const modelDefault = semanticModel ?? existingMemorySearchDefaults.model ?? "";
          const modelAnswer = (
            await rl.question(
              `Semantic model${modelDefault ? ` [${modelDefault}]` : ""}: `,
            )
          ).trim();
          semanticModel = modelAnswer || modelDefault || undefined;

          const baseUrlDefault = semanticBaseUrl ?? existingMemorySearchDefaults.baseUrl ?? "";
          const baseUrlAnswer = (
            await rl.question(
              `Semantic baseUrl${baseUrlDefault ? ` [${baseUrlDefault}]` : ""} [optional]: `,
            )
          ).trim();
          semanticBaseUrl = baseUrlAnswer || baseUrlDefault || undefined;

          const apiKeyPromptLabel =
            typeof semanticApiKey === "string"
              ? "[provided]"
              : existingMemorySearchDefaults.apiKeyConfigured
                ? "[configured]"
                : "[optional]";
          const apiKeyAnswer = (
            await rl.question(`Semantic apiKey ${apiKeyPromptLabel} (Enter to keep/skip): `)
          ).trim();
          if (apiKeyAnswer) {
            semanticApiKey = apiKeyAnswer;
          }
        } else if (existingSemanticEnabled) {
          semanticConfigEnabled = false;
        }
        if (!maintenanceWorkspaceScope) {
          const promptResult = await promptForMaintenanceWorkspaceScope({
            rl,
            existingScope: existingMaintenanceWorkspaceScope,
            openClawConfig: existingConfig,
          });
          maintenanceEnabled = promptResult.maintenanceEnabled;
          extractorEnabled = promptResult.extractorEnabled;
          maintenanceWorkspaceScope = promptResult.maintenanceWorkspaceScope;
        } else {
          maintenanceEnabled = true;
          extractorEnabled = true;
        }
      } else {
        maintenanceEnabled = false;
        extractorEnabled = false;
        semanticResolvedEnabled = existingSemanticEnabled;
      }

      if (dbPassword) {
        const rotateAnswer = (
          await rl.question(
            `If user "${dbUser}" already exists, rotate its password? [y/N]: `,
          )
        )
          .trim()
          .toLowerCase();
        rotateDbPassword = rotateAnswer ? ["y", "yes"].includes(rotateAnswer) : false;
      }
    } finally {
      rl.close();
    }
  } else {
    if (
      (typeof semanticProvider === "string" ||
        typeof semanticModel === "string" ||
        typeof semanticBaseUrl === "string" ||
        typeof semanticApiKey === "string") &&
      params.options.semanticEnabled !== true &&
      !existingSemanticEnabled
    ) {
      throw new Error(
        "semantic provider/model/base-url/api-key options require --semantic-enabled or existing semantic.enabled=true",
      );
    }
    maintenanceWorkspaceScope = ensureNonInteractiveMaintenanceScopeDecision({
      skipConfig,
      maintenanceWorkspaceScopeMode,
      existingScope: existingMaintenanceWorkspaceScope,
    });
    maintenanceEnabled = !skipConfig;
    extractorEnabled = !skipConfig;
    if (params.options.semanticEnabled === true) {
      semanticConfigEnabled = true;
      semanticResolvedEnabled = true;
    } else if (existingSemanticEnabled) {
      semanticConfigEnabled = true;
      semanticResolvedEnabled = true;
    } else {
      semanticResolvedEnabled = false;
    }
  }

  if (semanticResolvedEnabled) {
    semanticProvider = semanticProvider ?? existingMemorySearchDefaults.provider;
    semanticModel = semanticModel ?? existingMemorySearchDefaults.model;
    semanticBaseUrl = semanticBaseUrl ?? existingMemorySearchDefaults.baseUrl;
    if (!semanticProvider) {
      throw new Error(
        "semantic setup requires agents.defaults.memorySearch.provider or --semantic-provider when semantic is enabled",
      );
    }
    if (!semanticModel) {
      throw new Error(
        "semantic setup requires agents.defaults.memorySearch.model or --semantic-model when semantic is enabled",
      );
    }
  }

  const semanticApiKeyConfigured =
    typeof semanticApiKey === "string" ? true : existingMemorySearchDefaults.apiKeyConfigured;

  validateDatabaseName(dbName);
  validateIdentifier(dbUser, "db-user");
  if (schema) {
    validateIdentifier(schema, "schema");
  }

  if (!dbPassword) {
    dbPassword = generatePassword();
  }

  return {
    adminUrl,
    dbName,
    dbUser,
    dbPassword,
    rotateDbPassword,
    schema,
    maintenanceWorkspaceScope,
    maintenanceEnabled,
    extractorEnabled,
    semanticConfigEnabled,
    semanticResolvedEnabled,
    semanticProvider,
    semanticModel,
    semanticBaseUrl,
    semanticApiKey,
    semanticApiKeyConfigured,
    skipConfig: Boolean(params.options.skipConfig),
    nonInteractive,
  };
}

async function ensureDatabaseAndRole(params: {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  rotateDbPassword: boolean;
}): Promise<{ databaseExists: boolean; userExists: boolean; passwordChanged: boolean }> {
  const client = new Client({ connectionString: params.adminUrl });
  await client.connect();
  try {
    const dbRows = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [params.dbName]);
    const databaseExists = (dbRows.rowCount ?? 0) > 0;
    if (!databaseExists) {
      await client.query(`CREATE DATABASE ${quoteIdentifier(params.dbName)}`);
    }

    const userRows = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [params.dbUser]);
    const userExists = (userRows.rowCount ?? 0) > 0;
    let passwordChanged = false;
    if (!userExists) {
      await client.query(`CREATE USER ${quoteIdentifier(params.dbUser)} WITH LOGIN PASSWORD '${params.dbPassword.replaceAll("'", "''")}'`);
      passwordChanged = true;
    } else if (params.rotateDbPassword) {
      await client.query(`ALTER USER ${quoteIdentifier(params.dbUser)} WITH PASSWORD '${params.dbPassword.replaceAll("'", "''")}'`);
      passwordChanged = true;
    }
    await client.query(`ALTER DATABASE ${quoteIdentifier(params.dbName)} OWNER TO ${quoteIdentifier(params.dbUser)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(params.dbName)} TO ${quoteIdentifier(params.dbUser)}`);
    await client.query(`GRANT CREATE ON DATABASE ${quoteIdentifier(params.dbName)} TO ${quoteIdentifier(params.dbUser)}`);

    return { databaseExists, userExists, passwordChanged };
  } finally {
    await client.end();
  }
}

function buildTargetConnectionUrl(adminUrl: string, dbName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

async function detectUnsafeSchemaConflict(params: {
  client: Client;
  schema: string;
}): Promise<boolean> {
  const rows = await params.client.query<{
    table_name: string;
  }>(
    `
SELECT table_name
FROM information_schema.tables
WHERE table_schema = $1
AND table_name IN (
  'memory_items',
  'memory_daily_entries',
  'memory_daily_blocks',
  'memory_daily_block_extraction_windows',
  'session_index_files',
  'session_index_chunks',
  'schema_migrations'
)
`,
    [params.schema],
  );
  const tableNames = new Set(rows.rows.map((row) => row.table_name));
  if (tableNames.size === 0) {
    return false;
  }
  if (tableNames.has("schema_migrations")) {
    return true;
  }
  throw new Error(
    `Refusing to proceed: schema "${params.schema}" has AnchorClaw-like table names but no schema_migrations. Use a different schema.`,
  );
}

async function detectManagedSchemaOwnerMismatch(params: {
  client: Client;
  schema: string;
  dbUser: string;
}): Promise<void> {
  const rows = await params.client.query<{
    table_name: string;
    table_owner: string;
  }>(
    `
SELECT tablename AS table_name, tableowner AS table_owner
FROM pg_tables
WHERE schemaname = $1
  AND tableowner <> $2
ORDER BY tablename
`,
    [params.schema, params.dbUser],
  );
  if (rows.rowCount === 0) {
    return;
  }

  const byOwner = new Map<string, string[]>();
  for (const row of rows.rows) {
    const names = byOwner.get(row.table_owner) ?? [];
    names.push(row.table_name);
    byOwner.set(row.table_owner, names);
  }
  const summary = Array.from(byOwner.entries())
    .map(([owner, tableNames]) => `${owner}: ${tableNames.join(", ")}`)
    .join("; ");
  throw new Error(
    `Refusing to proceed: managed schema "${params.schema}" contains existing tables owned by another role (${summary}). Re-run setup with the original dbUser or migrate ownership manually.`,
  );
}

async function ensureSchemaAndGrants(params: {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  schema: string | undefined;
}): Promise<void> {
  const targetUrl = buildTargetConnectionUrl(params.adminUrl, params.dbName);
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    if (!params.schema) {
      return;
    }
    const hasManagedSchema = await detectUnsafeSchemaConflict({ client, schema: params.schema });
    if (hasManagedSchema) {
      await detectManagedSchemaOwnerMismatch({ client, schema: params.schema, dbUser: params.dbUser });
    }
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(params.schema)} AUTHORIZATION ${quoteIdentifier(params.dbUser)}`,
    );
    await client.query(`ALTER SCHEMA ${quoteIdentifier(params.schema)} OWNER TO ${quoteIdentifier(params.dbUser)}`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(params.schema)} TO ${quoteIdentifier(params.dbUser)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(params.schema)} GRANT ALL ON TABLES TO ${quoteIdentifier(params.dbUser)}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quoteIdentifier(params.schema)} GRANT ALL ON SEQUENCES TO ${quoteIdentifier(params.dbUser)}`);
  } finally {
    await client.end();
  }
}

async function ensureSemanticProvisioning(params: {
  adminUrl: string;
  dbName: string;
  schema: string | undefined;
}): Promise<{ applied: string[] }> {
  const targetUrl = buildTargetConnectionUrl(params.adminUrl, params.dbName);
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    if (params.schema) {
      await client.query(`SET search_path TO ${quoteIdentifier(params.schema)}, public`);
    }
    const poolLike = {
      query: async (text: string, values?: unknown[]) => client.query(text, values),
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => client.query(text, values),
        release: () => undefined,
      }),
    } as any;

    // Semantic tables reference the base AnchorClaw schema, so a clean setup
    // must establish that schema before applying the semantic migration set.
    const baseMigrations = await loadBundledMigrationsFromDisk();
    await applyMigrations({
      pool: poolLike,
      migrations: baseMigrations,
    });
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    const migrations = await loadBundledSemanticMigrationsFromDisk();
    return applyMigrations({
      pool: poolLike,
      migrations,
      tableName: "semantic_schema_migrations",
    });
  } finally {
    await client.end();
  }
}

function updateOpenClawConfig(params: {
  dbName: string;
  dbUser: string;
  dbPassword?: string;
  adminUrl: string;
  schema: string | undefined;
  maintenanceWorkspaceScope?: MaintenanceWorkspaceScopeConfig;
  maintenanceEnabled: boolean;
  extractorEnabled: boolean;
  semanticEnabled?: boolean;
  semanticProvider?: string;
  semanticModel?: string;
  semanticBaseUrl?: string;
  semanticApiKey?: string;
}): {
  path: string;
  updated: boolean;
  promptInjectionBefore: PromptInjectionConfigState;
  promptInjectionAfter: PromptInjectionConfigState;
  sessionMemoryBefore: SessionMemoryHookConfigState;
  sessionMemoryAfter: SessionMemoryHookConfigState;
} {
  const cfgPath = resolveOpenClawConfigPath();
  if (!existsSync(cfgPath)) {
    return {
      path: cfgPath,
      updated: false,
      promptInjectionBefore: "unset",
      promptInjectionAfter: "unset",
      sessionMemoryBefore: "unset",
      sessionMemoryAfter: "unset",
    };
  }

  const raw = readFileSync(cfgPath, "utf-8");
  const cfg = JSON.parse(raw) as Record<string, any>;
  const promptInjectionBefore = readPromptInjectionConfigState(cfg);
  const sessionMemoryBefore = readSessionMemoryHookConfigState(cfg);
  const parsedAdmin = new URL(params.adminUrl);
  const host = parsedAdmin.hostname || "localhost";
  const port = parsedAdmin.port ? Number(parsedAdmin.port) : 5432;

  cfg.plugins ??= {};
  cfg.plugins.slots ??= {};
  cfg.plugins.entries ??= {};
  cfg.plugins.slots.memory = "anchorclaw";
  cfg.plugins.entries.anchorclaw ??= {};
  cfg.plugins.entries.anchorclaw.enabled = true;
  cfg.plugins.entries.anchorclaw.config ??= {};
  if (typeof params.semanticEnabled === "boolean") {
    const existingSemanticConfig = asRecord(cfg.plugins.entries.anchorclaw.config.semantic);
    cfg.plugins.entries.anchorclaw.config.semantic = {
      ...existingSemanticConfig,
      enabled: params.semanticEnabled,
    };
  }
  const existingPostgresConfig = cfg.plugins.entries.anchorclaw.config.postgres ?? {};
  const nextPostgresConfig: Record<string, unknown> = {
    ...existingPostgresConfig,
    host,
    port,
    database: params.dbName,
    user: params.dbUser,
  };
  if (params.schema) {
    nextPostgresConfig.schema = params.schema;
  } else {
    delete nextPostgresConfig.schema;
  }
  if (typeof params.dbPassword === "string") {
    nextPostgresConfig.password = params.dbPassword;
  }
  cfg.plugins.entries.anchorclaw.config.postgres = nextPostgresConfig;
  if (typeof params.semanticEnabled === "boolean" && params.semanticEnabled) {
    cfg.agents ??= {};
    cfg.agents.defaults ??= {};
    const existingMemorySearch = asRecord(cfg.agents.defaults.memorySearch);
    const existingRemote = asRecord(existingMemorySearch.remote);
    const nextMemorySearch: Record<string, unknown> = {
      ...existingMemorySearch,
      ...(params.semanticProvider ? { provider: params.semanticProvider } : {}),
      ...(params.semanticModel ? { model: params.semanticModel } : {}),
    };
    const nextRemote: Record<string, unknown> = { ...existingRemote };
    if (typeof params.semanticBaseUrl === "string") {
      nextRemote.baseUrl = params.semanticBaseUrl;
    }
    if (typeof params.semanticApiKey === "string") {
      nextRemote.apiKey = params.semanticApiKey;
    }
    if (Object.keys(nextRemote).length > 0) {
      nextMemorySearch.remote = nextRemote;
    }
    cfg.agents.defaults.memorySearch = nextMemorySearch;
  }
  const existingMaintenanceConfig = asRecord(cfg.plugins.entries.anchorclaw.config.maintenance);
  const existingMaintenanceWorkspaceScope = readExistingMaintenanceWorkspaceScope(cfg);
  const resolvedMaintenanceWorkspaceScope =
    params.maintenanceWorkspaceScope ?? existingMaintenanceWorkspaceScope;
  const existingExtractorConfig = asRecord(existingMaintenanceConfig.extractor);
  delete existingExtractorConfig.agentId;
  const nextMaintenanceConfig: Record<string, unknown> = {
    ...existingMaintenanceConfig,
    enabled: params.maintenanceEnabled,
    dryRun: false,
    intervalMinutes:
      typeof existingMaintenanceConfig.intervalMinutes === "number"
        ? existingMaintenanceConfig.intervalMinutes
        : 12 * 60,
    batchSize:
      typeof existingMaintenanceConfig.batchSize === "number"
        ? existingMaintenanceConfig.batchSize
        : 200,
    ...(resolvedMaintenanceWorkspaceScope ? { workspaceScope: resolvedMaintenanceWorkspaceScope } : {}),
    extractor: {
      ...existingExtractorConfig,
      enabled: params.extractorEnabled,
      maxCandidates:
        typeof existingExtractorConfig.maxCandidates === "number"
          ? existingExtractorConfig.maxCandidates
          : 10,
      maxCharsPerRun:
        typeof existingExtractorConfig.maxCharsPerRun === "number"
          ? existingExtractorConfig.maxCharsPerRun
          : 12_000,
    },
  };
  if (!resolvedMaintenanceWorkspaceScope) {
    delete nextMaintenanceConfig.workspaceScope;
  }
  cfg.plugins.entries.anchorclaw.config.maintenance = nextMaintenanceConfig;
  cfg.plugins.entries.anchorclaw.hooks ??= {};
  cfg.plugins.entries.anchorclaw.hooks.allowPromptInjection = true;

  const hooks = asRecord(cfg.hooks);
  cfg.hooks = hooks;
  const internalHooks = asRecord(hooks.internal);
  hooks.internal = internalHooks;
  const internalEntries = asRecord(internalHooks.entries);
  internalHooks.entries = internalEntries;
  const sessionMemoryEntry = asRecord(internalEntries["session-memory"]);
  internalEntries["session-memory"] = {
    ...sessionMemoryEntry,
    enabled: false,
  };

  const promptInjectionAfter = readPromptInjectionConfigState(cfg);
  const sessionMemoryAfter = readSessionMemoryHookConfigState(cfg);

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return {
    path: cfgPath,
    updated: true,
    promptInjectionBefore,
    promptInjectionAfter,
    sessionMemoryBefore,
    sessionMemoryAfter,
  };
}

export async function runAnchorClawSetup(opts: AnchorClawSetupOptions = {}): Promise<void> {
  const options = await promptIfNeeded({ options: opts });
  const dbState = await ensureDatabaseAndRole({
    adminUrl: options.adminUrl,
    dbName: options.dbName,
    dbUser: options.dbUser,
    dbPassword: options.dbPassword,
    rotateDbPassword: options.rotateDbPassword,
  });
  await ensureSchemaAndGrants({
    adminUrl: options.adminUrl,
    dbName: options.dbName,
    dbUser: options.dbUser,
    schema: options.schema,
  });
  const semanticProvisioning = options.semanticResolvedEnabled
    ? await ensureSemanticProvisioning({
        adminUrl: options.adminUrl,
        dbName: options.dbName,
        schema: options.schema,
      })
    : undefined;

  let configUpdate: ReturnType<typeof updateOpenClawConfig> | undefined;
  if (!options.skipConfig) {
    const shouldWriteConfigPassword = !dbState.userExists || dbState.passwordChanged;
    configUpdate = updateOpenClawConfig({
      dbName: options.dbName,
      dbUser: options.dbUser,
      dbPassword: shouldWriteConfigPassword ? options.dbPassword : undefined,
      adminUrl: options.adminUrl,
      schema: options.schema,
      maintenanceWorkspaceScope: options.maintenanceWorkspaceScope,
      maintenanceEnabled: options.maintenanceEnabled,
      extractorEnabled: options.extractorEnabled,
      semanticEnabled: options.semanticConfigEnabled,
      semanticProvider: options.semanticProvider,
      semanticModel: options.semanticModel,
      semanticBaseUrl: options.semanticBaseUrl,
      semanticApiKey: options.semanticApiKey,
    });
  }

  console.log("\nAnchorClaw setup complete");
  console.log(`- database: ${options.dbName} (${dbState.databaseExists ? "already existed" : "created"})`);
  console.log(`- user: ${options.dbUser} (${dbState.userExists ? "already existed" : "created"})`);
  console.log(`- schema: ${options.schema ?? "(default search_path/public fallback)"}`);
  if (!dbState.userExists) {
    console.log("- password: created for new user");
  } else if (dbState.passwordChanged) {
    console.log("- password: rotated for existing user");
  } else {
    console.log("- password: preserved for existing user");
  }
  if (!options.schema) {
    console.warn(
      'Warning: no schema configured; runtime will use default PostgreSQL search_path (commonly public).',
    );
  }
  if (dbState.userExists && !dbState.passwordChanged) {
    console.warn(`Warning: User "${options.dbUser}" already exists. Existing database password was preserved.`);
    console.warn("Warning: openclaw.json password was left unchanged.");
  }
  if (options.skipConfig) {
    console.log("- config: skipped (--skip-config)");
  } else if (configUpdate?.updated) {
    console.log(`- config: updated ${configUpdate.path}`);
  } else if (configUpdate) {
    console.log(`- config: not found (${configUpdate.path})`);
  }
  if (!options.skipConfig && options.semanticResolvedEnabled) {
    if (configUpdate?.updated) {
      console.log("- semantic: enabled");
      if (options.semanticProvider) {
        console.log(`- memorySearch provider: ${options.semanticProvider}`);
      }
      if (options.semanticModel) {
        console.log(`- memorySearch model: ${options.semanticModel}`);
      }
      if (options.semanticBaseUrl) {
        console.log(`- memorySearch baseUrl: ${options.semanticBaseUrl}`);
      }
      console.log(`- memorySearch apiKey: ${options.semanticApiKeyConfigured ? "configured" : "not configured"}`);
      console.log(
        `- semantic schema: ${semanticProvisioning && semanticProvisioning.applied.length > 0
          ? `applied ${semanticProvisioning.applied.join(", ")}`
          : "ready"}`,
      );
    } else if (configUpdate) {
      console.warn("Warning: semantic settings were not written because openclaw.json was not found.");
      console.log(
        `- semantic schema: ${semanticProvisioning && semanticProvisioning.applied.length > 0
          ? `applied ${semanticProvisioning.applied.join(", ")}`
          : "ready"}`,
      );
    }
  } else if (!options.skipConfig && options.semanticConfigEnabled === false && configUpdate?.updated) {
    console.log("- semantic: disabled");
  } else if (options.semanticResolvedEnabled) {
    console.log(
      `- semantic schema: ${semanticProvisioning && semanticProvisioning.applied.length > 0
        ? `applied ${semanticProvisioning.applied.join(", ")}`
        : "ready"}`,
    );
  }
  if (!options.skipConfig && configUpdate?.updated) {
    if (configUpdate.sessionMemoryAfter === "disabled" && configUpdate.sessionMemoryBefore !== "disabled") {
      console.log("- bundled session-memory hook: disabled for DB-backed /new and /reset daily capture");
    }
    if (configUpdate.promptInjectionAfter === "enabled" && configUpdate.promptInjectionBefore !== "enabled") {
      console.log("- hooks.allowPromptInjection: enabled for DB-backed daily startup injection");
    }
    if (options.maintenanceEnabled && options.extractorEnabled) {
      const scopeLabel = formatMaintenanceWorkspaceScope(options.maintenanceWorkspaceScope);
      if (scopeLabel) {
        console.log(`- maintenance extractor scope: ${scopeLabel}`);
      }
    } else {
      console.log("- maintenance: disabled");
    }
  }
}
