export type SessionDeltaState = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
};

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
    error?: string;
  };
  sessions?: {
    enabled: boolean;
    visibility: "off" | "current" | "visible";
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

export type PromptCacheState = {
  lines: string[] | null;
  error: string | null;
  refreshPromise: Promise<void> | null;
};

export type SessionsIndexState = {
  bootstrapPromise: Promise<void> | null;
  bootstrapped: boolean;
};

export type SessionDeltaRuntimeState = {
  pendingFiles: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  syncInFlight: Promise<void> | null;
  unsubscribe: (() => void) | null;
  closed: boolean;
  ignoredPathCounts: Map<string, number>;
  stateByPath: Map<string, SessionDeltaState>;
};
