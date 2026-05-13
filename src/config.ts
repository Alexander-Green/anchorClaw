export type AnchorClawConfig = {
  identity?: {
    externalId?: string;
  };
  postgres: {
    host: string;
    port?: number;
    database: string;
    schema?: string;
    user: string;
    password?: string;
    ssl?: boolean;
    sslMode?: "disable" | "require" | "verify-full";
    sslCa?: string;
    pool?: {
      max?: number;
      connectionTimeoutMs?: number;
      idleTimeoutMs?: number;
    };
  };
  import?: {
    /**
     * After successfully importing `MEMORY.md` into Postgres, overwrite `MEMORY.md` with an empty stub
     * (to prevent duplicate prompt injection from OpenClaw bootstrap + AnchorClaw DB injection).
     */
    cleanupMemoryMdAfterImport?: boolean;
  };
  limits?: {
    maxResults?: number;
    getMaxChars?: number;
    getDefaultLines?: number;
  };
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveEnvVars(trimmed);
}

function readOptionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be non-empty`);
  }
  return resolveEnvVars(trimmed);
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} required`);
  }
  return resolveEnvVars(value.trim());
}

function readOptionalPort(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const resolved =
    typeof value === "string" ? resolveEnvVars(value.trim()) : (value as unknown);

  if (typeof resolved === "string") {
    if (!resolved) {
      return undefined;
    }
    const parsed = Number(resolved);
    if (!Number.isInteger(parsed)) {
      throw new Error(`${label} must be an integer`);
    }
    value = parsed;
  } else {
    value = resolved;
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`);
  }
  if (value < 1 || value > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function readOptionalIntegerInRange(params: {
  value: unknown;
  label: string;
  min: number;
  max: number;
}): number | undefined {
  if (params.value === undefined || params.value === null) {
    return undefined;
  }
  if (typeof params.value !== "number" || !Number.isInteger(params.value)) {
    throw new Error(`${params.label} must be an integer`);
  }
  if (params.value < params.min || params.value > params.max) {
    throw new Error(`${params.label} must be between ${params.min} and ${params.max}`);
  }
  return params.value;
}

export const anchorClawConfigSchema = {
  parse(value: unknown): AnchorClawConfig {
    const obj = asRecord(value);
    if (!obj) {
      throw new Error("anchorclaw config required");
    }
    assertAllowedKeys(obj, ["identity", "postgres", "import", "limits"], "anchorclaw config");

    const identityObj = asRecord(obj.identity);
    if (obj.identity !== undefined && !identityObj) {
      throw new Error("identity must be an object");
    }
    if (identityObj) {
      assertAllowedKeys(identityObj, ["externalId"], "identity");
    }
    const identityExternalId = identityObj
      ? readOptionalNonEmptyString(identityObj.externalId, "identity.externalId")
      : undefined;
    if (identityExternalId && identityExternalId.length > 20) {
      throw new Error("identity.externalId must be at most 20 characters");
    }

    const postgresObj = asRecord(obj.postgres);
    if (!postgresObj) {
      throw new Error("postgres config required");
    }
    assertAllowedKeys(
      postgresObj,
      ["host", "port", "database", "schema", "user", "password", "ssl", "sslMode", "sslCa", "pool"],
      "postgres config",
    );

    const host = readRequiredString(postgresObj.host, "postgres.host");
    const database = readRequiredString(postgresObj.database, "postgres.database");
    const schema = readOptionalString(postgresObj.schema, "postgres.schema");
    const user = readRequiredString(postgresObj.user, "postgres.user");
    const password = readOptionalString(postgresObj.password, "postgres.password");
    const port = readOptionalPort(postgresObj.port, "postgres.port");
    const ssl = readOptionalBoolean(postgresObj.ssl, "postgres.ssl");
    const sslModeRaw = readOptionalString(postgresObj.sslMode, "postgres.sslMode");
    const sslCa = readOptionalString(postgresObj.sslCa, "postgres.sslCa");
    const poolObj = asRecord(postgresObj.pool);
    if (postgresObj.pool !== undefined && !poolObj) {
      throw new Error("postgres.pool must be an object");
    }
    if (poolObj) {
      assertAllowedKeys(poolObj, ["max", "connectionTimeoutMs", "idleTimeoutMs"], "postgres.pool");
    }

    const sslMode = sslModeRaw
      ? sslModeRaw === "disable" || sslModeRaw === "require" || sslModeRaw === "verify-full"
        ? (sslModeRaw as "disable" | "require" | "verify-full")
        : (() => {
            throw new Error("postgres.sslMode must be one of: disable, require, verify-full");
          })()
      : undefined;

    if (typeof ssl === "boolean" && sslMode) {
      throw new Error("postgres.ssl and postgres.sslMode are mutually exclusive; use only sslMode");
    }
    if (sslCa && !sslMode) {
      throw new Error("postgres.sslCa requires postgres.sslMode=verify-full");
    }
    if (sslMode && sslMode !== "verify-full" && sslCa) {
      throw new Error("postgres.sslCa is only valid with postgres.sslMode=verify-full");
    }

    const poolMax = poolObj
      ? readOptionalIntegerInRange({
          value: poolObj.max,
          label: "postgres.pool.max",
          min: 1,
          max: 100,
        })
      : undefined;
    const poolConnectionTimeoutMs = poolObj
      ? readOptionalIntegerInRange({
          value: poolObj.connectionTimeoutMs,
          label: "postgres.pool.connectionTimeoutMs",
          min: 100,
          max: 600_000,
        })
      : undefined;
    const poolIdleTimeoutMs = poolObj
      ? readOptionalIntegerInRange({
          value: poolObj.idleTimeoutMs,
          label: "postgres.pool.idleTimeoutMs",
          min: 100,
          max: 3_600_000,
        })
      : undefined;

    const importObj = asRecord(obj.import);
    if (obj.import !== undefined && !importObj) {
      throw new Error("import must be an object");
    }
    if (importObj) {
      assertAllowedKeys(importObj, ["cleanupMemoryMdAfterImport"], "import");
    }
    const cleanupMemoryMdAfterImport = importObj
      ? readOptionalBoolean(importObj.cleanupMemoryMdAfterImport, "import.cleanupMemoryMdAfterImport")
      : undefined;

    const limitsObj = asRecord(obj.limits);
    if (obj.limits !== undefined && !limitsObj) {
      throw new Error("limits must be an object");
    }
    if (limitsObj) {
      assertAllowedKeys(limitsObj, ["maxResults", "getMaxChars", "getDefaultLines"], "limits");
    }
    const limitMaxResults = limitsObj
      ? readOptionalIntegerInRange({
          value: limitsObj.maxResults,
          label: "limits.maxResults",
          min: 1,
          max: 10,
        })
      : undefined;
    const limitGetMaxChars = limitsObj
      ? readOptionalIntegerInRange({
          value: limitsObj.getMaxChars,
          label: "limits.getMaxChars",
          min: 1000,
          max: 12_000,
        })
      : undefined;
    const limitGetDefaultLines = limitsObj
      ? readOptionalIntegerInRange({
          value: limitsObj.getDefaultLines,
          label: "limits.getDefaultLines",
          min: 10,
          max: 120,
        })
      : undefined;

    return {
      ...(identityExternalId ? { identity: { externalId: identityExternalId } } : {}),
      postgres: {
        host,
        ...(typeof port === "number" ? { port } : {}),
        database,
        ...(schema ? { schema } : {}),
        user,
        ...(password ? { password } : {}),
        ...(typeof ssl === "boolean" ? { ssl } : {}),
        ...(sslMode ? { sslMode } : {}),
        ...(sslCa ? { sslCa } : {}),
        ...(poolMax || poolConnectionTimeoutMs || poolIdleTimeoutMs
          ? {
              pool: {
                ...(poolMax ? { max: poolMax } : {}),
                ...(poolConnectionTimeoutMs
                  ? { connectionTimeoutMs: poolConnectionTimeoutMs }
                  : {}),
                ...(poolIdleTimeoutMs ? { idleTimeoutMs: poolIdleTimeoutMs } : {}),
              },
            }
          : {}),
      },
      import: { cleanupMemoryMdAfterImport: cleanupMemoryMdAfterImport ?? true },
      ...(limitMaxResults || limitGetMaxChars || limitGetDefaultLines
        ? {
            limits: {
              ...(limitMaxResults ? { maxResults: limitMaxResults } : {}),
              ...(limitGetMaxChars ? { getMaxChars: limitGetMaxChars } : {}),
              ...(limitGetDefaultLines ? { getDefaultLines: limitGetDefaultLines } : {}),
            },
          }
        : {}),
    };
  },
};
