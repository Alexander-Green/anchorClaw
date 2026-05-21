import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
  patchAgents?: boolean;
  skipAgentsPatch?: boolean;
  enablePromptInjection?: boolean;
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
  patchAgents: boolean;
  skipAgentsPatch: boolean;
  enablePromptInjection: boolean;
  nonInteractive: boolean;
};

type PromptInjectionConfigState = "enabled" | "disabled" | "unset";

export type AgentsInstructionPatchResult =
  | { status: "skipped"; reason: string }
  | { status: "not_found"; path: string }
  | { status: "unchanged"; path: string }
  | { status: "patched"; path: string; backupPath: string }
  | { status: "failed"; path: string; reason: string };

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

function removeKnownSection(content: string, pattern: RegExp, requiredMarkers: string[]): string {
  return content.replace(pattern, (match, prefix = "") => {
    if (!requiredMarkers.every((marker) => match.includes(marker))) {
      return match;
    }
    return prefix;
  });
}

function removeKnownOpenClawFileMemoryInstructions(content: string): string {
  let updated = content;

  updated = removeKnownSection(
    updated,
    /(^|\r?\n)## Memory\r?\n[\s\S]*?(?=\r?\n## Red Lines\r?\n)/,
    [
      "### MEMORY.md - Your Long-Term Memory",
      "Write It Down - No \"Mental Notes\"!",
      "- **Long-term:** `MEMORY.md`",
    ],
  );
  updated = removeKnownSection(
    updated,
    /(^|\r?\n)(?:- \*\*Review and update MEMORY\.md\*\* \(see below\)\r?\n(?:\r?\n)?)?### [^\r\n]*Memory Maintenance \(During Heartbeats\)\r?\n[\s\S]*?(?=\r?\nThe goal: Be helpful without being annoying\.)/,
    [
      "- **Review and update MEMORY.md** (see below)",
      "1. Read through recent `memory/YYYY-MM-DD.md` files",
      "2. Identify significant events, lessons, or insights worth keeping long-term",
      "3. Update `MEMORY.md` with distilled learnings",
    ],
  );

  return updated;
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

function readPromptInjectionStateFromConfigFile(): PromptInjectionConfigState {
  const cfgPath = resolveOpenClawConfigPath();
  if (!existsSync(cfgPath)) {
    return "unset";
  }
  try {
    const raw = readFileSync(cfgPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, any>;
    return readPromptInjectionConfigState(cfg);
  } catch {
    return "unset";
  }
}

function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function patchWorkspaceAgentsInstructions(params: {
  workspaceDir: string | undefined;
}): AgentsInstructionPatchResult {
  if (!params.workspaceDir) {
    return { status: "skipped", reason: "workspaceDir is not configured" };
  }

  const agentsPath = resolve(params.workspaceDir, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return { status: "not_found", path: agentsPath };
  }

  try {
    const original = readFileSync(agentsPath, "utf-8");
    const updated = removeKnownOpenClawFileMemoryInstructions(original);
    if (updated === original) {
      return { status: "unchanged", path: agentsPath };
    }

    const backupDir = resolve(params.workspaceDir, ".openclaw-repair", "anchorclaw");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `AGENTS.md.anchorclaw-backup.${backupStamp()}.md`);
    writeFileSync(backupPath, original);
    writeFileSync(agentsPath, updated);
    return { status: "patched", path: agentsPath, backupPath };
  } catch (error) {
    return {
      status: "failed",
      path: agentsPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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
  let patchAgents = Boolean(params.options.patchAgents);
  let skipAgentsPatch = Boolean(params.options.skipAgentsPatch);
  let rotateDbPassword = Boolean(params.options.rotateDbPassword);
  let enablePromptInjection = Boolean(params.options.enablePromptInjection);

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
      if (!update) {
        patchAgents = false;
        skipAgentsPatch = true;
      }

      const existingPromptInjectionState = update ? readPromptInjectionStateFromConfigFile() : "unset";
      if (update && !enablePromptInjection && existingPromptInjectionState === "disabled") {
        const promptInjectionAnswer = (
          await rl.question(
            "Enable hooks.allowPromptInjection in openclaw.json for DB-backed daily startup injection if it is currently false? [Y/n]: ",
          )
        )
          .trim()
          .toLowerCase();
        enablePromptInjection = promptInjectionAnswer ? !["n", "no"].includes(promptInjectionAnswer) : true;
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
  }

  validateIdentifier(dbName, "db-name");
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
    patchAgents,
    skipAgentsPatch,
    enablePromptInjection,
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
}): Promise<void> {
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
    return;
  }
  if (tableNames.has("schema_migrations")) {
    return;
  }
  throw new Error(
    `Refusing to proceed: schema "${params.schema}" has AnchorClaw-like table names but no schema_migrations. Use a different schema.`,
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
    await detectUnsafeSchemaConflict({ client, schema: params.schema });
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
  enablePromptInjection: boolean;
}): {
  path: string;
  updated: boolean;
  promptInjectionBefore: PromptInjectionConfigState;
  promptInjectionAfter: PromptInjectionConfigState;
} {
  const cfgPath = resolveOpenClawConfigPath();
  if (!existsSync(cfgPath)) {
    return {
      path: cfgPath,
      updated: false,
      promptInjectionBefore: "unset",
      promptInjectionAfter: "unset",
    };
  }

  const raw = readFileSync(cfgPath, "utf-8");
  const cfg = JSON.parse(raw) as Record<string, any>;
  const promptInjectionBefore = readPromptInjectionConfigState(cfg);
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
  if (params.enablePromptInjection) {
    cfg.plugins.entries.anchorclaw.hooks ??= {};
    cfg.plugins.entries.anchorclaw.hooks.allowPromptInjection = true;
  }

  const promptInjectionAfter = readPromptInjectionConfigState(cfg);

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return {
    path: cfgPath,
    updated: true,
    promptInjectionBefore,
    promptInjectionAfter,
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
      enablePromptInjection: options.enablePromptInjection,
    });
  }

  const agentsPatch =
    !options.skipConfig && configUpdate?.updated && options.patchAgents && !options.skipAgentsPatch
      ? patchWorkspaceAgentsInstructions({ workspaceDir: options.workspaceDir })
      : undefined;

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
    if (configUpdate.promptInjectionAfter === "enabled" && configUpdate.promptInjectionBefore !== "enabled") {
      console.log("- hooks.allowPromptInjection: enabled for DB-backed daily startup injection");
    } else if (configUpdate.promptInjectionBefore === "disabled" && configUpdate.promptInjectionAfter === "disabled") {
      console.warn("Warning: hooks.allowPromptInjection is false in openclaw.json.");
      console.warn("Warning: AnchorClaw daily startup injection will stay degraded until prompt injection is enabled.");
      console.warn("Warning: Re-run `openclaw anchorclaw setup --enable-prompt-injection` to enable it automatically.");
    }
  }
  if (options.skipConfig) {
    console.log("- AGENTS.md patch: skipped (config update disabled)");
  } else if (options.patchAgents && options.skipAgentsPatch) {
    console.log("- AGENTS.md patch: skipped (--skip-agents-patch)");
  } else if (!options.patchAgents) {
    console.log("- AGENTS.md patch: not requested (use --patch-agents if legacy file-memory instructions conflict)");
  } else if (options.skipAgentsPatch) {
    console.log("- AGENTS.md patch: skipped (--skip-agents-patch)");
  } else if (agentsPatch?.status === "patched") {
    console.log(`- AGENTS.md patch: updated ${agentsPatch.path}`);
    console.log(`- AGENTS.md backup: ${agentsPatch.backupPath}`);
  } else if (agentsPatch?.status === "unchanged") {
    console.log(`- AGENTS.md patch: no matching OpenClaw file-memory instructions found (${agentsPatch.path})`);
  } else if (agentsPatch?.status === "not_found") {
    console.log(`- AGENTS.md patch: not found (${agentsPatch.path})`);
  } else if (agentsPatch?.status === "failed") {
    console.warn(`- AGENTS.md patch: failed (${agentsPatch.reason}); AGENTS.md was left unchanged`);
  }
  if (options.workspaceDir) {
    console.log(`- workspaceDir: ${options.workspaceDir}`);
  } else if (!options.skipConfig) {
    console.warn("- workspaceDir: not configured; set plugins.entries.anchorclaw.config.workspaceDir before enabling import");
  }
}
