import type { PostgresPool } from "./postgres.js";

type MigrationRecord = {
  id: string;
  applied_at: string;
};

function migrationIdFromFilename(filename: string): string {
  const match = filename.match(/^(\d+)_/u);
  return match ? match[1] : filename;
}

function assertSafeTableName(tableName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableName)) {
    throw new Error(`migration table name must be a simple identifier: ${tableName}`);
  }
  return tableName;
}

export async function ensureMigrationsTable(params: {
  pool: PostgresPool;
  tableName?: string;
}): Promise<void> {
  const tableName = assertSafeTableName(params.tableName ?? "schema_migrations");
  await params.pool.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function listAppliedMigrations(params: {
  pool: PostgresPool;
  tableName?: string;
}): Promise<Set<string>> {
  const tableName = assertSafeTableName(params.tableName ?? "schema_migrations");
  const { rows } = await params.pool.query<MigrationRecord>(
    `SELECT id, applied_at FROM ${tableName} ORDER BY id`,
  );
  return new Set(rows.map((row: MigrationRecord) => row.id));
}

export async function applyMigrations(params: {
  pool: PostgresPool;
  migrations: Array<{ filename: string; sql: string }>;
  tableName?: string;
}): Promise<{ applied: string[] }> {
  const tableName = assertSafeTableName(params.tableName ?? "schema_migrations");
  await ensureMigrationsTable({ pool: params.pool, tableName });
  const applied = await listAppliedMigrations({ pool: params.pool, tableName });

  const appliedNow: string[] = [];
  for (const migration of params.migrations) {
    const id = migrationIdFromFilename(migration.filename);
    if (applied.has(id)) {
      continue;
    }

    const client = await params.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${tableName} (id) VALUES ($1)`, [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    appliedNow.push(id);
  }

  return { applied: appliedNow };
}
