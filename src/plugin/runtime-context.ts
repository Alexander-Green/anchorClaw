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
import type {
  PromptCacheState,
  SdkHealthState,
  SessionDeltaRuntimeState,
  SessionsIndexState,
} from "./types.js";

const SDK_RECOVERY_SUCCESS_THRESHOLD = 3;

export type PluginRuntimeContext = {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig | undefined;
  disabledReason: string | undefined;
  pool: PostgresPool | undefined;
  migrationsApplied: Promise<void> | undefined;
  promptCache: PromptCacheState;
  sessionsIndex: SessionsIndexState;
  sessionDelta: SessionDeltaRuntimeState;
  sdkHealth: SdkHealthState;
  resolveActor: () => string;
  getPool: () => PostgresPool;
  ensureReady: () => Promise<void>;
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
      return ctx.pool!;
    },
    ensureReady: async () => {
      ctx.getPool();
      await ctx.migrationsApplied;
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
