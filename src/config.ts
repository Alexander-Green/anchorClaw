export type AnchorClawMaintenanceWorkspaceScope =
  | { mode: "default-agent" }
  | { mode: "all-agent-workspaces" }
  | { mode: "agents"; agents: string[] };

export type AnchorClawConfig = {
  debug?: {
    promptLogEnabled?: boolean;
  };
  semantic?: {
    enabled?: boolean;
  };
  sessions?: {
    search?: {
      enabled?: boolean;
    };
    visibility?: "current" | "off" | "visible";
    sync?: {
      deltaBytes?: number;
      deltaMessages?: number;
    };
  };
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
  maintenance?: {
    enabled?: boolean;
    dryRun?: boolean;
    intervalMinutes?: number;
    batchSize?: number;
    workspaceScope?: AnchorClawMaintenanceWorkspaceScope;
    extractor?: {
      enabled?: boolean;
      maxCandidates?: number;
      maxCharsPerRun?: number;
    };
  };
  limits?: {
    maxResults?: number;
    getMaxChars?: number;
    getDefaultLines?: number;
  };
};

export const DEFAULT_SESSION_DELTA_BYTES = 100_000;
export const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const MULTI_AGENT_ARCHITECTURE_REF = "See ARCHITECTURE.md#multi-agent-workspace-model";
const WORKSPACE_DIR_REMOVED_MESSAGE =
  "workspaceDir was removed in AnchorClaw 0.0.9 because workspace routing now follows the OpenClaw multi-agent model. " +
  MULTI_AGENT_ARCHITECTURE_REF;

export type SessionsSearchState = {
  configured: boolean;
  visibility: "current" | "off" | "visible";
  effective: boolean;
  reason: "search_disabled" | "visibility_off" | null;
};

export type SemanticLayerState = {
  configured: boolean;
  enabled: boolean;
  effective: boolean;
  reason: "semantic_disabled" | "semantic_not_implemented" | null;
};

export type ResolvedAgentMemorySearchConfig = {
  configured: boolean;
  source: "agent" | "defaults" | null;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyConfigured: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readLooseOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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

function readNonEmptyStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${label} must contain only strings`);
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      throw new Error(`${label} must not contain empty values`);
    }
    const resolved = resolveEnvVars(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    items.push(resolved);
  }
  if (items.length === 0) {
    throw new Error(`${label} must contain at least one agent id`);
  }
  return items;
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
    if (Object.prototype.hasOwnProperty.call(obj, "workspaceDir")) {
      throw new Error(WORKSPACE_DIR_REMOVED_MESSAGE);
    }
    assertAllowedKeys(
      obj,
      ["debug", "semantic", "sessions", "identity", "postgres", "maintenance", "limits"],
      "anchorclaw config",
    );

    const debugObj = asRecord(obj.debug);
    if (obj.debug !== undefined && !debugObj) {
      throw new Error("debug must be an object");
    }
    if (debugObj) {
      assertAllowedKeys(debugObj, ["promptLogEnabled"], "debug");
    }
    const debugPromptLogEnabled = debugObj
      ? readOptionalBoolean(debugObj.promptLogEnabled, "debug.promptLogEnabled")
      : undefined;

    const semanticObj = asRecord(obj.semantic);
    if (obj.semantic !== undefined && !semanticObj) {
      throw new Error("semantic must be an object");
    }
    if (semanticObj) {
      assertAllowedKeys(semanticObj, ["enabled"], "semantic");
    }
    const semanticEnabled = semanticObj
      ? readOptionalBoolean(semanticObj.enabled, "semantic.enabled")
      : undefined;

    const sessionsObj = asRecord(obj.sessions);
    if (obj.sessions !== undefined && !sessionsObj) {
      throw new Error("sessions must be an object");
    }
    if (sessionsObj) {
      assertAllowedKeys(sessionsObj, ["search", "visibility", "sync"], "sessions");
    }
    const sessionsSearchObj = sessionsObj ? asRecord(sessionsObj.search) : undefined;
    if (sessionsObj?.search !== undefined && !sessionsSearchObj) {
      throw new Error("sessions.search must be an object");
    }
    if (sessionsSearchObj) {
      assertAllowedKeys(sessionsSearchObj, ["enabled"], "sessions.search");
    }
    const sessionsSearchEnabled = sessionsSearchObj
      ? readOptionalBoolean(sessionsSearchObj.enabled, "sessions.search.enabled")
      : undefined;
    const visibilityRaw = sessionsObj
      ? readOptionalString(sessionsObj.visibility, "sessions.visibility")
      : undefined;
    const sessionsVisibility = visibilityRaw
      ? visibilityRaw === "current" || visibilityRaw === "off" || visibilityRaw === "visible"
        ? (visibilityRaw as "current" | "off" | "visible")
        : (() => {
            throw new Error("sessions.visibility must be one of: current, off, visible");
          })()
      : "current";
    const sessionsSyncObj = sessionsObj ? asRecord(sessionsObj.sync) : undefined;
    if (sessionsObj?.sync !== undefined && !sessionsSyncObj) {
      throw new Error("sessions.sync must be an object");
    }
    if (sessionsSyncObj) {
      assertAllowedKeys(sessionsSyncObj, ["deltaBytes", "deltaMessages"], "sessions.sync");
    }
    const sessionsDeltaBytes = sessionsSyncObj
      ? readOptionalIntegerInRange({
          value: sessionsSyncObj.deltaBytes,
          label: "sessions.sync.deltaBytes",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        })
      : undefined;
    const sessionsDeltaMessages = sessionsSyncObj
      ? readOptionalIntegerInRange({
          value: sessionsSyncObj.deltaMessages,
          label: "sessions.sync.deltaMessages",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        })
      : undefined;

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

    const maintenanceObj = asRecord(obj.maintenance);
    if (obj.maintenance !== undefined && !maintenanceObj) {
      throw new Error("maintenance must be an object");
    }
    if (maintenanceObj) {
      assertAllowedKeys(
        maintenanceObj,
        ["enabled", "dryRun", "intervalMinutes", "batchSize", "workspaceScope", "extractor"],
        "maintenance",
      );
    }
    const maintenanceEnabled = maintenanceObj
      ? readOptionalBoolean(maintenanceObj.enabled, "maintenance.enabled")
      : undefined;
    const maintenanceDryRun = maintenanceObj
      ? readOptionalBoolean(maintenanceObj.dryRun, "maintenance.dryRun")
      : undefined;
    const maintenanceIntervalMinutes = maintenanceObj
      ? readOptionalIntegerInRange({
          value: maintenanceObj.intervalMinutes,
          label: "maintenance.intervalMinutes",
          min: 1,
          max: 24 * 60,
        })
      : undefined;
    const maintenanceBatchSize = maintenanceObj
      ? readOptionalIntegerInRange({
          value: maintenanceObj.batchSize,
          label: "maintenance.batchSize",
          min: 1,
          max: 2000,
        })
      : undefined;
    const maintenanceWorkspaceScopeObj = maintenanceObj ? asRecord(maintenanceObj.workspaceScope) : null;
    if (maintenanceObj?.workspaceScope !== undefined && !maintenanceWorkspaceScopeObj) {
      throw new Error("maintenance.workspaceScope must be an object");
    }
    if (maintenanceWorkspaceScopeObj) {
      assertAllowedKeys(maintenanceWorkspaceScopeObj, ["mode", "agents"], "maintenance.workspaceScope");
    }
    let maintenanceWorkspaceScope: AnchorClawMaintenanceWorkspaceScope | undefined;
    if (maintenanceWorkspaceScopeObj) {
      const mode = readRequiredString(maintenanceWorkspaceScopeObj.mode, "maintenance.workspaceScope.mode");
      if (mode === "default-agent") {
        if (maintenanceWorkspaceScopeObj.agents !== undefined) {
          throw new Error("maintenance.workspaceScope.agents is only allowed when mode=agents");
        }
        maintenanceWorkspaceScope = { mode };
      } else if (mode === "all-agent-workspaces") {
        if (maintenanceWorkspaceScopeObj.agents !== undefined) {
          throw new Error("maintenance.workspaceScope.agents is only allowed when mode=agents");
        }
        maintenanceWorkspaceScope = { mode };
      } else if (mode === "agents") {
        maintenanceWorkspaceScope = {
          mode,
          agents: readNonEmptyStringArray(
            maintenanceWorkspaceScopeObj.agents,
            "maintenance.workspaceScope.agents",
          ),
        };
      } else {
        throw new Error(
          'maintenance.workspaceScope.mode must be one of "default-agent", "all-agent-workspaces", or "agents"',
        );
      }
    }
    const maintenanceExtractorObj = maintenanceObj ? asRecord(maintenanceObj.extractor) : null;
    if (maintenanceObj?.extractor !== undefined && !maintenanceExtractorObj) {
      throw new Error("maintenance.extractor must be an object");
    }
    if (maintenanceExtractorObj && Object.prototype.hasOwnProperty.call(maintenanceExtractorObj, "agentId")) {
      throw new Error(
        "maintenance.extractor.agentId was removed in AnchorClaw 0.0.9 because workspace routing now follows the OpenClaw multi-agent model. " +
          MULTI_AGENT_ARCHITECTURE_REF,
      );
    }
    if (maintenanceExtractorObj) {
      assertAllowedKeys(
        maintenanceExtractorObj,
        ["enabled", "maxCandidates", "maxCharsPerRun"],
        "maintenance.extractor",
      );
    }
    const maintenanceExtractorEnabled = maintenanceExtractorObj
      ? readOptionalBoolean(maintenanceExtractorObj.enabled, "maintenance.extractor.enabled")
      : undefined;
    const maintenanceExtractorMaxCandidates = maintenanceExtractorObj
      ? readOptionalIntegerInRange({
          value: maintenanceExtractorObj.maxCandidates,
          label: "maintenance.extractor.maxCandidates",
          min: 1,
          max: 100,
        })
      : undefined;
    const maintenanceExtractorMaxCharsPerRun = maintenanceExtractorObj
      ? readOptionalIntegerInRange({
          value: maintenanceExtractorObj.maxCharsPerRun,
          label: "maintenance.extractor.maxCharsPerRun",
          min: 1000,
          max: 200_000,
        })
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
      ...(typeof debugPromptLogEnabled === "boolean"
        ? {
            debug: {
              promptLogEnabled: debugPromptLogEnabled,
            },
          }
        : {}),
      ...(typeof semanticEnabled === "boolean"
        ? {
            semantic: {
              enabled: semanticEnabled,
            },
          }
        : {}),
      sessions: {
        search: {
          enabled: sessionsSearchEnabled ?? false,
        },
        visibility: sessionsVisibility,
        sync: {
          deltaBytes: sessionsDeltaBytes ?? DEFAULT_SESSION_DELTA_BYTES,
          deltaMessages: sessionsDeltaMessages ?? DEFAULT_SESSION_DELTA_MESSAGES,
        },
      },
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
      maintenance: {
        enabled: maintenanceEnabled ?? false,
        dryRun: maintenanceDryRun ?? true,
        intervalMinutes: maintenanceIntervalMinutes ?? 12 * 60,
        batchSize: maintenanceBatchSize ?? 200,
        ...(maintenanceWorkspaceScope ? { workspaceScope: maintenanceWorkspaceScope } : {}),
        extractor: {
          enabled: maintenanceExtractorEnabled ?? false,
          maxCandidates: maintenanceExtractorMaxCandidates ?? 10,
          maxCharsPerRun: maintenanceExtractorMaxCharsPerRun ?? 12_000,
        },
      },
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

export function resolveSessionsSearchState(
  cfg: Pick<AnchorClawConfig, "sessions"> | null | undefined,
): SessionsSearchState {
  const visibility = cfg?.sessions?.visibility ?? "current";
  const configured = cfg?.sessions?.search?.enabled === true;
  if (!configured) {
    return {
      configured: false,
      visibility,
      effective: false,
      reason: "search_disabled",
    };
  }
  if (visibility === "off") {
    return {
      configured: true,
      visibility,
      effective: false,
      reason: "visibility_off",
    };
  }
  return {
    configured: true,
    visibility,
    effective: true,
    reason: null,
  };
}

export function resolveSemanticLayerState(
  cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined,
): SemanticLayerState {
  const enabled = cfg?.semantic?.enabled === true;
  if (!enabled) {
    return {
      configured: false,
      enabled: false,
      effective: false,
      reason: "semantic_disabled",
    };
  }
  return {
    configured: true,
    enabled: true,
    effective: false,
    reason: "semantic_not_implemented",
  };
}

function readRuntimeMemorySearchConfig(value: unknown): Omit<
  ResolvedAgentMemorySearchConfig,
  "configured" | "source"
> {
  const obj = asRecord(value);
  const remote = asRecord(obj?.remote);
  const provider = readLooseOptionalString(obj?.provider);
  const model = readLooseOptionalString(obj?.model);
  const baseUrl = readLooseOptionalString(remote?.baseUrl);
  const apiKeyConfigured = Boolean(readLooseOptionalString(remote?.apiKey));
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyConfigured,
  };
}

function hasRuntimeMemorySearchConfig(
  value: Omit<ResolvedAgentMemorySearchConfig, "configured" | "source">,
): boolean {
  return Boolean(value.provider || value.model || value.baseUrl || value.apiKeyConfigured);
}

export function resolveAgentMemorySearchConfig(params: {
  runtimeConfig: unknown;
  agentId?: string | null | undefined;
}): ResolvedAgentMemorySearchConfig {
  const runtimeConfig = asRecord(params.runtimeConfig);
  const agents = asRecord(runtimeConfig?.agents);
  const defaults = readRuntimeMemorySearchConfig(asRecord(agents?.defaults)?.memorySearch);

  const agentId = readLooseOptionalString(params.agentId);
  if (agentId && Array.isArray(agents?.list)) {
    for (const entry of agents.list) {
      const agent = asRecord(entry);
      if (readLooseOptionalString(agent?.id) !== agentId) {
        continue;
      }
      const resolved = readRuntimeMemorySearchConfig(agent?.memorySearch);
      if (hasRuntimeMemorySearchConfig(resolved)) {
        return {
          configured: true,
          source: "agent",
          ...resolved,
        };
      }
      break;
    }
  }

  if (hasRuntimeMemorySearchConfig(defaults)) {
    return {
      configured: true,
      source: "defaults",
      ...defaults,
    };
  }

  return {
    configured: false,
    source: null,
    apiKeyConfigured: false,
  };
}
