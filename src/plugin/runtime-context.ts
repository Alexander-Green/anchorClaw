import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { resolveActor } from "./runtime-helpers.js";
import {
  createPostgresPool,
  type PostgresPool,
} from "../postgres.js";
import { loadBundledMigrationsFromDisk } from "../migrations-fs.js";
import { applyMigrations } from "../migrations.js";
import { listKnownAgentIds } from "../memory/sessions.js";
import { isTransientDbError } from "../db-errors.js";
import type {
  DurableMemoryState,
  PromptCacheState,
  SdkHealthState,
  SessionDeltaRuntimeState,
  SessionsIndexState,
} from "./types.js";

const SDK_RECOVERY_SUCCESS_THRESHOLD = 3;
const STARTUP_RETRY_ATTEMPTS = 3;
const STARTUP_RETRY_BASE_DELAY_MS = 500;

export type PluginRuntimeContext = {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig | undefined;
  disabledReason: string | undefined;
  startupCriticalFailure: string | undefined;
  durableState: DurableMemoryState;
  pool: PostgresPool | undefined;
  migrationsApplied: Promise<void> | undefined;
  promptCache: PromptCacheState;
  sessionsIndex: SessionsIndexState;
  sessionDelta: SessionDeltaRuntimeState;
  sdkHealth: SdkHealthState;
  resolveActor: () => string;
  getPool: () => PostgresPool;
  ensureConnectionReady: () => Promise<void>;
  ensureReady: () => Promise<void>;
  setDurableState: (next: Partial<DurableMemoryState>) => void;
  setStartupCriticalFailure: (reason: string | undefined) => void;
  markSdkError: (operation: string, error: unknown) => void;
  markSdkSuccess: () => void;
  listVisibleAgentIds: () => Promise<string[]>;
};

export function createPluginRuntimeContext(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig | undefined;
  disabledReason: string | undefined;
}): PluginRuntimeContext {
  const ctx: PluginRuntimeContext = {
    api: params.api,
    cfg: params.cfg,
    disabledReason: params.disabledReason,
    startupCriticalFailure: undefined,
    durableState: {
      backend: "anchorclaw",
      overall: params.disabledReason ? "blocked" : "pending",
      database: "pending",
      migrations: "pending",
      import: "pending",
      cleanup: "not_needed",
      reason: params.disabledReason ?? null,
      lastImportRunId: null,
      lastSourceSha256: null,
    },
    pool: undefined,
    migrationsApplied: undefined,
    promptCache: {
      lines: null,
      error: null,
      refreshPromise: null,
    },
    sessionsIndex: {
      bootstrapPromise: null,
      bootstrapped: false,
    },
    sessionDelta: {
      pendingFiles: new Set<string>(),
      timer: null,
      syncInFlight: null,
      unsubscribe: null,
      closed: false,
      ignoredPathCounts: new Map<string, number>(),
      stateByPath: new Map(),
    },
    sdkHealth: {
      degraded: false,
      consecutiveSuccesses: 0,
    },
    resolveActor: () => resolveActor(params.api),
    getPool: () => {
      if (!ctx.cfg) {
        throw new Error(
          `anchorclaw: disabled until configured (${ctx.disabledReason ?? "invalid config"})`,
        );
      }
      ctx.pool ??= createPostgresPool({ cfg: ctx.cfg });
      return ctx.pool!;
    },
    ensureConnectionReady: async () => {
      const pool = ctx.getPool();
      await pool.query("SELECT 1");
    },
    setDurableState: (next: Partial<DurableMemoryState>) => {
      ctx.durableState = {
        ...ctx.durableState,
        ...next,
      };
    },
    setStartupCriticalFailure: (reason: string | undefined) => {
      ctx.startupCriticalFailure = reason;
    },
    ensureReady: async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= STARTUP_RETRY_ATTEMPTS; attempt += 1) {
        try {
          await ctx.ensureConnectionReady();
          ctx.migrationsApplied ??= (async () => {
            if (ctx.cfg?.postgres?.schema) {
              const schema = ctx.cfg.postgres.schema.trim();
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
                throw new Error(
                  "postgres.schema must be a simple identifier (letters/numbers/underscore)",
                );
              }
              await ctx.pool!.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
            }
            const migrations = await loadBundledMigrationsFromDisk();
            const result = await applyMigrations({ pool: ctx.pool!, migrations });
            if (result.applied.length > 0) {
              params.api.logger.info(
                `anchorclaw: applied migrations: ${result.applied.join(", ")}`,
              );
            }
          })();
          try {
            await ctx.migrationsApplied;
          } catch (error) {
            ctx.migrationsApplied = undefined;
            throw error;
          }
          return;
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);
          const transient = isTransientDbError(message);
          if (!transient || attempt >= STARTUP_RETRY_ATTEMPTS) {
            throw error;
          }
          const delay = STARTUP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          params.api.logger.warn(
            `anchorclaw: ensureReady transient failure (attempt ${attempt}/${STARTUP_RETRY_ATTEMPTS}, retrying in ${delay}ms: ${message})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    markSdkError: (operation: string, error: unknown) => {
      ctx.sdkHealth.degraded = true;
      ctx.sdkHealth.consecutiveSuccesses = 0;
      ctx.sdkHealth.affectedOperation = operation;
      ctx.sdkHealth.reason = error instanceof Error ? error.message : String(error);
      ctx.sdkHealth.lastErrorAt = new Date().toISOString();
    },
    markSdkSuccess: () => {
      if (!ctx.sdkHealth.degraded) {
        return;
      }
      ctx.sdkHealth.consecutiveSuccesses += 1;
      if (ctx.sdkHealth.consecutiveSuccesses < SDK_RECOVERY_SUCCESS_THRESHOLD) {
        return;
      }
      ctx.sdkHealth.degraded = false;
      ctx.sdkHealth.reason = undefined;
      ctx.sdkHealth.affectedOperation = undefined;
      ctx.sdkHealth.lastErrorAt = undefined;
      ctx.sdkHealth.consecutiveSuccesses = 0;
    },
    listVisibleAgentIds: async () => {
      const currentAgentId = String((params.api as any)?.runtime?.agentId ?? "main");
      const agentIds = await listKnownAgentIds();
      return [currentAgentId, ...agentIds.filter((agentId) => agentId !== currentAgentId)];
    },
  };

  return ctx;
}
