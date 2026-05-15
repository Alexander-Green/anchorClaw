export type SessionDeltaState = {
  lastSize: number;
  pendingBytes: number;
  pendingMessages: number;
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
