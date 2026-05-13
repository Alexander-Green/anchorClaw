import type { PostgresPool } from "./postgres.js";

type MigrationRecord = {
  id: string;
  applied_at: string;
};

function migrationIdFromFilename(filename: string): string {
  const match = filename.match(/^(\d+)_/u);
  return match ? match[1] : filename;
}

export async function ensureMigrationsTable(params: { pool: PostgresPool }): Promise<void> {
  await params.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export async function listAppliedMigrations(params: {
  pool: PostgresPool;
}): Promise<Set<string>> {
  const { rows } = await params.pool.query<MigrationRecord>(
    "SELECT id, applied_at FROM schema_migrations ORDER BY id",
  );
  return new Set(rows.map((row: MigrationRecord) => row.id));
}

export async function applyMigrations(params: {
  pool: PostgresPool;
  migrations: Array<{ filename: string; sql: string }>;
}): Promise<{ applied: string[] }> {
  await ensureMigrationsTable({ pool: params.pool });
  const applied = await listAppliedMigrations({ pool: params.pool });

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
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
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
