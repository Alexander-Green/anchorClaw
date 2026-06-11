export type SessionDeltaState = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
};

export type LegacyFileState = "absent" | "stub" | "pending" | "already_imported_active";

export type DurableOverallState = "pending" | "ready" | "blocked" | "degraded";
export type DurableStepState = "pending" | "ready" | "failed";
export type DurableImportState = "pending" | "not_needed" | "ready" | "failed_retryable" | "failed_permanent";
export type DurableCleanupState = "not_needed" | "completed" | "failed";

export type DurableMemoryState = {
  backend: "anchorclaw";
  overall: DurableOverallState;
  database: DurableStepState;
  migrations: DurableStepState;
  import: DurableImportState;
  cleanup: DurableCleanupState;
  reason?: string | null;
  lastImportRunId?: string | null;
  lastSourceSha256?: string | null;
};

export type SdkHealthState = {
  degraded: boolean;
  reason?: string;
  affectedOperation?: string;
  lastErrorAt?: string;
  consecutiveSuccesses: number;
};

export type SessionDeltaThresholds = {
  deltaBytes: number;
  deltaMessages: number;
};

export type MemoryStatusCheckResult = {
  ok: boolean;
  backend: "anchorclaw";
  overall: DurableOverallState;
  databaseState: DurableStepState;
  migrationsState: DurableStepState;
  importState: DurableImportState;
  cleanupState: DurableCleanupState;
  reason?: string | null;
  mode: "cached" | "active";
  sdk: SdkHealthState;
  database?: {
    ok: boolean;
    latencyMs?: number;
    schemaOk?: boolean;
    migrationVersion?: string | null;
    dailySchemaOk?: boolean;
    error?: string;
  };
  daily?: {
    source: "db";
    injectionMode: "first_turn";
    promptInjectionAllowed: boolean;
    startupPromptEnabled: boolean;
    startupPromptEffective: boolean;
    readCompatibilityPath: "db-only";
    importMode: "canonical_table";
  };
  legacyImport?: {
    active: boolean;
    memoryMdState: LegacyFileState;
    pendingCount: number;
    unsupportedCount: number;
    unreadableCount?: number;
    dailyFileCount: number;
  };
  sessions?: {
    enabled: boolean;
    searchEnabled?: boolean;
    effectiveEnabled?: boolean;
    visibility: "off" | "current" | "visible";
    reasonCode?: "search_disabled" | "visibility_off";
    stateDir?: string;
    agentSessionsDir?: string;
    exists?: boolean;
    readable?: boolean;
    error?: string;
  };
  index?: {
    trackedFiles: number;
    pendingBytes: number;
    pendingMessages: number;
  };
};

export type SessionsIndexState = {
  bootstrapPromises: Map<string, Promise<void>>;
  bootstrappedKeys: Set<string>;
};

export type PendingSessionDelta = {
  sessionFile: string;
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
};

export type SessionDeltaRuntimeState = {
  pendingByPath: Map<string, PendingSessionDelta>;
  retryAttemptsByTarget: Map<string, number>;
  timer: ReturnType<typeof setTimeout> | null;
  syncInFlight: Promise<void> | null;
  unsubscribe: (() => void) | null;
  closed: boolean;
  ignoredPathCounts: Map<string, number>;
  stateByPath: Map<string, SessionDeltaState>;
};
