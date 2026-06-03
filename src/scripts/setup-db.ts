import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";

export type AnchorClawSetupOptions = {
  adminUrl?: string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  rotateDbPassword?: boolean;
  schema?: string;
  workspaceDir?: string;
  schemaNone?: boolean;
  skipConfig?: boolean;
  nonInteractive?: boolean;
};

type ResolvedSetupOptions = {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  rotateDbPassword: boolean;
  schema: string | undefined;
  workspaceDir: string | undefined;
  skipConfig: boolean;
  nonInteractive: boolean;
};

type PromptInjectionConfigState = "enabled" | "disabled" | "unset";
type SessionMemoryHookConfigState = "enabled" | "disabled" | "unset";

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

function resolveWorkspaceDefault(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitWorkspace = normalizeEnvPath(env.OPENCLAW_WORKSPACE_DIR);
  if (explicitWorkspace) {
    return resolve(explicitWorkspace);
  }
  const home = resolveOpenClawHomeDir(env);
  if (!home) {
    return undefined;
  }
  const profile = normalizeEnvPath(env.OPENCLAW_PROFILE);
  const workspaceName = profile && profile.toLowerCase() !== "default" ? `workspace-${profile}` : "workspace";
  return resolve(home, ".openclaw", workspaceName);
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

function resolveOptionalWorkspaceDir(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? resolve(trimmed) : undefined;
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

function ensureWorkspaceDirForConfig(params: {
  workspaceDir: string | undefined;
  skipConfig: boolean;
}): void {
  if (params.skipConfig || params.workspaceDir) {
    return;
  }
  throw new Error(
    "workspaceDir could not be resolved for config update; pass --workspace-dir, set OPENCLAW_WORKSPACE_DIR, or use --skip-config",
  );
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
  let workspaceDir = resolveOptionalWorkspaceDir(params.options.workspaceDir) ?? resolveWorkspaceDefault();

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

      if (!skipConfig) {
        const workspacePrompt = workspaceDir
          ? `Workspace directory [${workspaceDir}]: `
          : "Workspace directory [leave empty to configure later]: ";
        const workspaceAnswer = (await rl.question(workspacePrompt)).trim();
        if (workspaceAnswer) {
          workspaceDir = resolve(workspaceAnswer);
        }
      }

      const shouldUpdateByDefault = !skipConfig;
      const updateAnswer = (await rl.question(`Update openclaw.json? [${shouldUpdateByDefault ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      const update = updateAnswer
        ? !["n", "no"].includes(updateAnswer)
        : shouldUpdateByDefault;
      params.options.skipConfig = !update;

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
  }

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
    workspaceDir,
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
AND table_name IN ('memory_items', 'session_index_files', 'session_index_chunks', 'schema_migrations')
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

function updateOpenClawConfig(params: {
  dbName: string;
  dbUser: string;
  dbPassword?: string;
  adminUrl: string;
  schema: string | undefined;
  workspaceDir: string | undefined;
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
  if (params.workspaceDir) {
    cfg.plugins.entries.anchorclaw.config.workspaceDir = params.workspaceDir;
  }
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
  ensureWorkspaceDirForConfig({
    workspaceDir: options.workspaceDir,
    skipConfig: options.skipConfig,
  });
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

  let configUpdate: ReturnType<typeof updateOpenClawConfig> | undefined;
  if (!options.skipConfig) {
    const shouldWriteConfigPassword = !dbState.userExists || dbState.passwordChanged;
    configUpdate = updateOpenClawConfig({
      dbName: options.dbName,
      dbUser: options.dbUser,
      dbPassword: shouldWriteConfigPassword ? options.dbPassword : undefined,
      adminUrl: options.adminUrl,
      schema: options.schema,
      workspaceDir: options.workspaceDir,
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
  if (!options.skipConfig && configUpdate?.updated) {
    if (configUpdate.sessionMemoryAfter === "disabled" && configUpdate.sessionMemoryBefore !== "disabled") {
      console.log("- bundled session-memory hook: disabled for DB-backed /new and /reset daily capture");
    }
    if (configUpdate.promptInjectionAfter === "enabled" && configUpdate.promptInjectionBefore !== "enabled") {
      console.log("- hooks.allowPromptInjection: enabled for DB-backed daily startup injection");
    }
  }
  if (options.workspaceDir) {
    console.log(`- workspaceDir: ${options.workspaceDir}`);
  } else if (!options.skipConfig) {
    console.warn("- workspaceDir: not configured; set plugins.entries.anchorclaw.config.workspaceDir before enabling import");
  }
}
