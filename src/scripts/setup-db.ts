import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "pg";

export type AnchorClawSetupOptions = {
  adminUrl?: string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
  schema?: string;
  noSchema?: boolean;
  skipConfig?: boolean;
  nonInteractive?: boolean;
};

type ResolvedSetupOptions = {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  schema: string | undefined;
  skipConfig: boolean;
  nonInteractive: boolean;
};

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

  let adminUrl = params.options.adminUrl?.trim() || defaults.adminUrl;
  let dbName = params.options.dbName?.trim() || defaults.dbName;
  let dbUser = params.options.dbUser?.trim() || defaults.dbUser;
  let schema: string | undefined;

  if (params.options.noSchema) {
    schema = undefined;
  } else if (typeof params.options.schema === "string") {
    const rawSchema = params.options.schema.trim();
    schema = rawSchema.toLowerCase() === "none" || rawSchema === "" ? undefined : rawSchema;
  } else {
    schema = defaults.schema;
  }

  let dbPassword = params.options.dbPassword?.trim() || "";

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
    schema,
    skipConfig: Boolean(params.options.skipConfig),
    nonInteractive,
  };
}

async function ensureDatabaseAndRole(params: {
  adminUrl: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}): Promise<{ databaseExists: boolean; userExists: boolean }> {
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
    if (!userExists) {
      await client.query(`CREATE USER ${quoteIdentifier(params.dbUser)} WITH LOGIN PASSWORD '${params.dbPassword.replaceAll("'", "''")}'`);
    } else {
      await client.query(`ALTER USER ${quoteIdentifier(params.dbUser)} WITH PASSWORD '${params.dbPassword.replaceAll("'", "''")}'`);
    }
    await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(params.dbName)} TO ${quoteIdentifier(params.dbUser)}`);

    return { databaseExists, userExists };
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
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(params.schema)}`);
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
  dbPassword: string;
  adminUrl: string;
  schema: string | undefined;
}): { path: string; updated: boolean } {
  const cfgPath = resolve(process.env.HOME || "~", ".openclaw", "openclaw.json");
  if (!existsSync(cfgPath)) {
    return { path: cfgPath, updated: false };
  }

  const raw = readFileSync(cfgPath, "utf-8");
  const cfg = JSON.parse(raw) as Record<string, any>;
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
  cfg.plugins.entries.anchorclaw.config.postgres = {
    host,
    port,
    database: params.dbName,
    user: params.dbUser,
    password: params.dbPassword,
    ...(params.schema ? { schema: params.schema } : {}),
  };

  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return { path: cfgPath, updated: true };
}

export async function runAnchorClawSetup(opts: AnchorClawSetupOptions = {}): Promise<void> {
  const options = await promptIfNeeded({ options: opts });
  const dbState = await ensureDatabaseAndRole({
    adminUrl: options.adminUrl,
    dbName: options.dbName,
    dbUser: options.dbUser,
    dbPassword: options.dbPassword,
  });
  await ensureSchemaAndGrants({
    adminUrl: options.adminUrl,
    dbName: options.dbName,
    dbUser: options.dbUser,
    schema: options.schema,
  });

  let configUpdate: { path: string; updated: boolean } | undefined;
  if (!options.skipConfig) {
    configUpdate = updateOpenClawConfig({
      dbName: options.dbName,
      dbUser: options.dbUser,
      dbPassword: options.dbPassword,
      adminUrl: options.adminUrl,
      schema: options.schema,
    });
  }

  console.log("\nAnchorClaw setup complete");
  console.log(`- database: ${options.dbName} (${dbState.databaseExists ? "already existed" : "created"})`);
  console.log(`- user: ${options.dbUser} (${dbState.userExists ? "already existed" : "created"})`);
  console.log(`- schema: ${options.schema ?? "(default search_path/public fallback)"}`);
  console.log(`- password: ${options.dbPassword}`);
  if (!options.schema) {
    console.warn(
      'Warning: no schema configured; runtime will use default PostgreSQL search_path (commonly public).',
    );
  }
  if (options.skipConfig) {
    console.log("- config: skipped (--skip-config)");
  } else if (configUpdate?.updated) {
    console.log(`- config: updated ${configUpdate.path}`);
  } else if (configUpdate) {
    console.log(`- config: not found (${configUpdate.path})`);
  }
}
