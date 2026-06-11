import pg, { type PoolConfig } from "pg";
import type { AnchorClawConfig } from "./config.js";

export type PostgresPool = pg.Pool;

function assertSafeIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be a simple identifier (letters/numbers/underscore)`);
  }
  return trimmed;
}

function resolvePgSslOptions(params: {
  ssl?: boolean;
  sslMode?: "disable" | "require" | "verify-full";
  sslCa?: string;
}): PoolConfig["ssl"] {
  if (params.sslMode === "disable") {
    return false;
  }
  if (params.sslMode === "require") {
    return { rejectUnauthorized: false };
  }
  if (params.sslMode === "verify-full") {
    return {
      rejectUnauthorized: true,
      ...(params.sslCa ? { ca: params.sslCa } : {}),
    };
  }
  if (typeof params.ssl === "boolean") {
    return params.ssl;
  }
  return false;
}

export function createPostgresPool(params: { cfg: AnchorClawConfig }): pg.Pool {
  const { postgres } = params.cfg;
  const ssl = resolvePgSslOptions({
    ssl: postgres.ssl,
    sslMode: postgres.sslMode,
    sslCa: postgres.sslCa,
  });
  const schema = postgres.schema ? assertSafeIdentifier(postgres.schema, "postgres.schema") : undefined;
  const poolMax = postgres.pool?.max ?? 10;
  const connectionTimeoutMillis = postgres.pool?.connectionTimeoutMs ?? 5_000;
  const idleTimeoutMillis = postgres.pool?.idleTimeoutMs ?? 30_000;
  const port = postgres.port ?? 5432;
  return new pg.Pool({
    host: postgres.host,
    port,
    database: postgres.database,
    user: postgres.user,
    ...(postgres.password ? { password: postgres.password } : {}),
    ssl,
    max: poolMax,
    connectionTimeoutMillis,
    idleTimeoutMillis,
    allowExitOnIdle: true,
    ...(schema ? { options: `-c search_path=${schema},public` } : {}),
  });
}
