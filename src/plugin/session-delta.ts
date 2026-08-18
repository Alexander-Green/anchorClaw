import type { OpenClawPluginApi } from "../api.js";
import { resolveSessionsSearchState } from "../config.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { isSessionFileForAgent } from "../memory/sessions.js";
import { normalizeSessionLookupPath } from "../memory/sessions-index.js";
import { syncSessionsIndexDb, syncVisibleSessionsIndexDb } from "../memory/sessions-index-sync.js";
import {
  countNewlinesInRange,
  isSessionArchiveArtifactPath,
  resolveSessionDeltaThresholds,
} from "./session-delta-helpers.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceTarget,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";
import type { PendingSessionDelta } from "./types.js";
import { legacySessionPathForFile } from "../memory/legacy-session-files.js";
import fs from "node:fs/promises";
import { resolveSessionSearchMode } from "./session-search-mode.js";

const SESSION_DELTA_DEBOUNCE_MS = 5_000;
const SESSION_DELTA_RETRY_BASE_DELAY_MS = 2_000;
const SESSION_DELTA_RETRY_MAX_DELAY_MS = 30_000;
const SESSION_DELTA_LISTENER_REGISTRY_KEY = Symbol.for(
  "@alexandrgreen/anchorclaw.sessionDeltaListenerRegistry",
);

type SessionTranscriptSubscribe = OpenClawPluginApi["runtime"]["events"]["onSessionTranscriptUpdate"];
type SessionTranscriptUpdate = {
  sessionFile?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
};
type SharedSessionDeltaListener = {
  consumers: Map<object, (update: SessionTranscriptUpdate) => void>;
  unsubscribe: () => void;
};

function resolveSharedSessionDeltaListeners(): WeakMap<
  SessionTranscriptSubscribe,
  SharedSessionDeltaListener
> {
  const existing = Reflect.get(globalThis, SESSION_DELTA_LISTENER_REGISTRY_KEY) as unknown;
  if (existing instanceof WeakMap) {
    return existing as WeakMap<SessionTranscriptSubscribe, SharedSessionDeltaListener>;
  }
  const created = new WeakMap<SessionTranscriptSubscribe, SharedSessionDeltaListener>();
  Reflect.set(globalThis, SESSION_DELTA_LISTENER_REGISTRY_KEY, created);
  return created;
}

function resolveSessionAgentId(lookup: string): string | null {
  const parts = lookup.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "sessions") {
    return null;
  }
  return parts[1]?.trim() || null;
}

export type SessionDeltaRuntime = {
  ensureSessionsIndexBootstrapped: (target?: SessionIndexBootstrapTarget) => Promise<void>;
  ensureSessionDeltaListener: () => void;
  cleanupSessionDelta: () => void;
};

export type SessionIndexBootstrapTarget = {
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export function createSessionDeltaRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}): SessionDeltaRuntime {
  const { api, ctx } = params;
  const sessionSearchMode = resolveSessionSearchMode(api);
  const listenerOwner = {};
  const sharedSessionDeltaListeners = resolveSharedSessionDeltaListeners();

  const buildTargetKey = (target: Pick<PendingSessionDelta, "workspaceDir" | "agentId">): string =>
    `${target.workspaceDir}\u0000${target.agentId}`;

  const computeRetryDelayMs = (attempt: number): number =>
    Math.min(
      SESSION_DELTA_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      SESSION_DELTA_RETRY_MAX_DELAY_MS,
    );

  const scheduleFlush = (delayMs = SESSION_DELTA_DEBOUNCE_MS) => {
    if (ctx.sessionDelta.timer || ctx.sessionDelta.closed) {
      return;
    }
    ctx.sessionDelta.timer = setTimeout(() => {
      ctx.sessionDelta.timer = null;
      void flushSessionDeltaSync();
    }, delayMs);
    ctx.sessionDelta.timer.unref?.();
  };

  const requeueTargetUpdates = (updates: PendingSessionDelta[]): number => {
    if (updates.length === 0) {
      return 0;
    }
    const targetKey = buildTargetKey(updates[0]!);
    const nextAttempt = (ctx.sessionDelta.retryAttemptsByTarget.get(targetKey) ?? 0) + 1;
    ctx.sessionDelta.retryAttemptsByTarget.set(targetKey, nextAttempt);
    for (const update of updates) {
      ctx.sessionDelta.pendingByPath.set(update.sessionFile, update);
    }
    return computeRetryDelayMs(nextAttempt);
  };

  const ensureSessionsIndexBootstrapped = async (target?: SessionIndexBootstrapTarget) => {
    if (sessionSearchMode === "native-openclaw") {
      return;
    }
    if (!ctx.cfg) {
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      return;
    }
    const workspaceTarget = resolveRuntimeWorkspaceTarget({
      api,
      ...(target ?? {}),
    });
    if (!workspaceTarget) {
      api.logger.warn(`anchorclaw: sessions index bootstrap skipped (${RUNTIME_WORKSPACE_UNAVAILABLE})`);
      return;
    }
    const visibility = ctx.cfg.sessions?.visibility ?? "current";
    const visibleAgentIds =
      visibility === "visible"
        ? await ctx.listVisibleAgentIds(workspaceTarget.agentId)
        : [workspaceTarget.agentId];
    const bootstrapKey = [
      visibility,
      workspaceTarget.workspaceDir,
      ...visibleAgentIds.slice().sort(),
    ].join("\u0000");
    if (ctx.sessionsIndex.bootstrappedKeys.has(bootstrapKey)) {
      return;
    }
    const activeBootstrap = ctx.sessionsIndex.bootstrapPromises.get(bootstrapKey);
    if (activeBootstrap) {
      await activeBootstrap;
      return;
    }
    const bootstrapPromise = (async () => {
      try {
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          workspaceDir: workspaceTarget.workspaceDir,
          agentId: workspaceTarget.agentId,
          sessionKey: workspaceTarget.sessionKey,
          configuredExternalId: ctx.cfg?.identity?.externalId,
        });
        if (visibility === "visible") {
          await syncVisibleSessionsIndexDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            agentId: workspaceTarget.agentId,
            otherAgentIds: visibleAgentIds.filter((agentId) => agentId !== workspaceTarget.agentId),
          });
        } else {
          await syncSessionsIndexDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            agentId: workspaceTarget.agentId,
          });
        }
        ctx.sessionsIndex.bootstrappedKeys.add(bootstrapKey);
      } catch (error) {
        api.logger.warn(
          `anchorclaw: sessions index bootstrap failed (agent=${workspaceTarget.agentId}, workspace=${workspaceTarget.workspaceDir}: ${error instanceof Error ? error.message : String(error)})`,
        );
      } finally {
        ctx.sessionsIndex.bootstrapPromises.delete(bootstrapKey);
      }
    })();
    ctx.sessionsIndex.bootstrapPromises.set(bootstrapKey, bootstrapPromise);
    await bootstrapPromise;
  };

  const flushSessionDeltaSync = async () => {
    if (ctx.sessionDelta.closed) {
      ctx.sessionDelta.pendingByPath.clear();
      return;
    }
    if (!ctx.cfg) {
      ctx.sessionDelta.pendingByPath.clear();
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      ctx.sessionDelta.pendingByPath.clear();
      return;
    }
    if (ctx.sessionDelta.pendingByPath.size === 0) {
      return;
    }
    if (ctx.sessionDelta.syncInFlight) {
      return;
    }

    const batch = Array.from(ctx.sessionDelta.pendingByPath.values());
    const sessionDeltaThresholds = resolveSessionDeltaThresholds(ctx.cfg);
    ctx.sessionDelta.pendingByPath.clear();
    const dirtyUpdates: PendingSessionDelta[] = [];
    for (const update of batch) {
      const sessionFile = update.sessionFile;
      if (isSessionArchiveArtifactPath(sessionFile)) {
        dirtyUpdates.push(update);
        continue;
      }
      let statSize: number | null = null;
      try {
        const stat = await fs.stat(sessionFile);
        statSize = typeof stat.size === "number" ? stat.size : null;
      } catch {
        // If stat is unavailable, keep previous behavior and allow targeted sync.
        dirtyUpdates.push(update);
      }
      if (statSize === null) {
        continue;
      }
      const prev = ctx.sessionDelta.stateByPath.get(sessionFile) ?? {
        lastSize: 0,
        pendingBytes: 0,
        pendingMessages: 0,
      };
      const sizeReduced = statSize < prev.lastSize;
      const deltaBytes = sizeReduced ? statSize : Math.max(0, statSize - prev.lastSize);
      const pendingBytes = prev.pendingBytes + Math.max(0, deltaBytes);
      const shouldCountMessages =
        sessionDeltaThresholds.deltaMessages > 0 &&
        (sessionDeltaThresholds.deltaBytes <= 0 || pendingBytes < sessionDeltaThresholds.deltaBytes);
      const messageSpanStart = sizeReduced ? 0 : prev.lastSize;
      const deltaMessages = shouldCountMessages
        ? await countNewlinesInRange({
            filePath: sessionFile,
            start: messageSpanStart,
            end: statSize,
          })
        : 0;
      const pendingMessages = prev.pendingMessages + Math.max(0, deltaMessages);
      ctx.sessionDelta.stateByPath.set(sessionFile, {
        lastSize: statSize,
        pendingBytes,
        pendingMessages,
      });
      const bytesHit =
        sessionDeltaThresholds.deltaBytes <= 0
          ? pendingBytes > 0
          : pendingBytes >= sessionDeltaThresholds.deltaBytes;
      const messagesHit =
        sessionDeltaThresholds.deltaMessages > 0 &&
        pendingMessages >= sessionDeltaThresholds.deltaMessages;
      if (bytesHit || messagesHit) {
        dirtyUpdates.push(update);
      }
    }
    if (dirtyUpdates.length === 0) {
      return;
    }

    ctx.sessionDelta.syncInFlight = (async () => {
      let retryDelayMs = 0;
      const updatesByTarget = new Map<string, PendingSessionDelta[]>();
      try {
        api.logger.info(
          `anchorclaw: sessions delta flush start (batch=${batch.length}, dirty=${dirtyUpdates.length}, visibility=${ctx.cfg?.sessions?.visibility ?? "current"})`,
        );
        for (const update of dirtyUpdates) {
          const key = buildTargetKey(update);
          const existing = updatesByTarget.get(key);
          if (existing) {
            existing.push(update);
          } else {
            updatesByTarget.set(key, [update]);
          }
        }
        await ctx.ensureReady();

        let syncedTargets = 0;
        for (const [targetKey, updates] of updatesByTarget.entries()) {
          const target = updates[0]!;
          try {
            const scope = await resolveUserAndWorkspaceScope({
              api,
              pool: ctx.getPool(),
              workspaceDir: target.workspaceDir,
              agentId: target.agentId,
              sessionKey: target.sessionKey,
              configuredExternalId: ctx.cfg?.identity?.externalId,
            });
            await syncSessionsIndexDb({
              pool: ctx.getPool(),
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              agentId: target.agentId,
              sessionFiles: updates.map((update) => update.sessionFile),
            });
            syncedTargets += 1;
            ctx.sessionDelta.retryAttemptsByTarget.delete(targetKey);
          } catch (error) {
            const targetRetryDelayMs = requeueTargetUpdates(updates);
            retryDelayMs = Math.max(retryDelayMs, targetRetryDelayMs);
            api.logger.warn(
              `anchorclaw: sessions delta target sync failed (agent=${target.agentId}, workspace=${target.workspaceDir}: ${error instanceof Error ? error.message : String(error)}; retry in ${targetRetryDelayMs}ms)`,
            );
            continue;
          }
          for (const update of updates) {
            const state = ctx.sessionDelta.stateByPath.get(update.sessionFile);
            if (!state) {
              continue;
            }
            ctx.sessionDelta.stateByPath.set(update.sessionFile, {
              lastSize: state.lastSize,
              pendingBytes:
                sessionDeltaThresholds.deltaBytes > 0
                  ? Math.max(0, state.pendingBytes - sessionDeltaThresholds.deltaBytes)
                  : 0,
              pendingMessages:
                sessionDeltaThresholds.deltaMessages > 0
                  ? Math.max(0, state.pendingMessages - sessionDeltaThresholds.deltaMessages)
                  : 0,
            });
          }
        }
        api.logger.info(
          `anchorclaw: sessions delta flush done (batch=${batch.length}, dirty=${dirtyUpdates.length}, targets=${syncedTargets})`,
        );
      } catch (error) {
        for (const updates of updatesByTarget.values()) {
          retryDelayMs = Math.max(retryDelayMs, requeueTargetUpdates(updates));
        }
        api.logger.warn(
          `anchorclaw: sessions delta sync failed (${error instanceof Error ? error.message : String(error)}${retryDelayMs > 0 ? `; retry in ${retryDelayMs}ms` : ""})`,
        );
      } finally {
        ctx.sessionDelta.syncInFlight = null;
        if (ctx.sessionDelta.pendingByPath.size > 0 && !ctx.sessionDelta.closed && !ctx.sessionDelta.timer) {
          scheduleFlush(retryDelayMs > 0 ? retryDelayMs : SESSION_DELTA_DEBOUNCE_MS);
        }
      }
    })();

    await ctx.sessionDelta.syncInFlight;
  };

  const scheduleSessionDeltaSync = (update: PendingSessionDelta) => {
    const filePath = update.sessionFile.trim();
    if (!filePath || ctx.sessionDelta.closed) {
      return;
    }
    ctx.sessionDelta.pendingByPath.set(filePath, {
      ...update,
      sessionFile: filePath,
    });
    scheduleFlush();
  };

  const ensureSessionDeltaListener = () => {
    if (sessionSearchMode === "native-openclaw") {
      return;
    }
    if (!ctx.cfg || ctx.sessionDelta.closed || ctx.sessionDelta.unsubscribe) {
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      return;
    }
    const subscribe = api.runtime.events?.onSessionTranscriptUpdate;
    if (typeof subscribe !== "function") {
      api.logger.warn("anchorclaw: runtime.events.onSessionTranscriptUpdate unavailable; sessions delta sync disabled");
      return;
    }
    const warnIgnoredUpdate = (key: string, reason: string) => {
      const next = (ctx.sessionDelta.ignoredPathCounts.get(key) ?? 0) + 1;
      ctx.sessionDelta.ignoredPathCounts.set(key, next);
      if (next === 1 || next === 5 || next % 20 === 0) {
        api.logger.warn(`anchorclaw: ignored session delta update ${reason} (${key}) [count=${next}]`);
      }
    };
    const resolveSessionDeltaTarget = async (
      update: SessionTranscriptUpdate,
    ): Promise<PendingSessionDelta | null> => {
      const sessionFile = typeof update.sessionFile === "string" ? update.sessionFile.trim() : "";
      if (!sessionFile) {
        return null;
      }
      const lookup = normalizeSessionLookupPath(legacySessionPathForFile(sessionFile));
      const pathAgentId = lookup ? resolveSessionAgentId(lookup) : null;
      const eventAgentId =
        typeof update.agentId === "string" && update.agentId.trim() ? update.agentId.trim() : null;
      if (!lookup || !pathAgentId) {
        warnIgnoredUpdate(sessionFile, "due to unrecognized path");
        return null;
      }
      if (eventAgentId && eventAgentId !== pathAgentId) {
        warnIgnoredUpdate(
          lookup,
          `due to agent/path mismatch (event=${eventAgentId}, path=${pathAgentId})`,
        );
        return null;
      }
      const agentId = eventAgentId ?? pathAgentId;
      const inAgentDir = await isSessionFileForAgent({
        sessionFile,
        agentId,
      });
      if (!inAgentDir) {
        warnIgnoredUpdate(lookup, "due to unrecognized path");
        return null;
      }
      const sessionKey =
        typeof update.sessionKey === "string" && update.sessionKey.trim()
          ? update.sessionKey.trim()
          : undefined;
      const runtimeAgentId = String((api as any)?.runtime?.agentId ?? "").trim();
      const runtimeWorkspaceDir =
        agentId === runtimeAgentId && typeof (api as any)?.runtime?.workspaceDir === "string"
          ? (api as any).runtime.workspaceDir
          : undefined;
      const workspaceTarget = resolveRuntimeWorkspaceTarget({
        api,
        agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(runtimeWorkspaceDir ? { workspaceDir: runtimeWorkspaceDir } : {}),
      });
      if (!workspaceTarget) {
        warnIgnoredUpdate(lookup, `because workspace is unavailable for agent ${agentId}`);
        return null;
      }
      return {
        sessionFile,
        workspaceDir: workspaceTarget.workspaceDir,
        agentId: workspaceTarget.agentId,
        ...(workspaceTarget.sessionKey ? { sessionKey: workspaceTarget.sessionKey } : {}),
      };
    };
    const consumeUpdate = (update: SessionTranscriptUpdate) => {
      if (ctx.sessionDelta.closed) {
        return;
      }
      const sessionFile = typeof update?.sessionFile === "string" ? update.sessionFile : "";
      if (!sessionFile) {
        return;
      }
      api.logger.info(`anchorclaw: transcript update event received (${sessionFile})`);
      void (async () => {
        const target = await resolveSessionDeltaTarget(update);
        if (!target) {
          return;
        }
        api.logger.info(
          `anchorclaw: transcript update accepted for delta sync (${sessionFile}, agent=${target.agentId}, workspace=${target.workspaceDir})`,
        );
        scheduleSessionDeltaSync(target);
      })();
    };
    let sharedListener = sharedSessionDeltaListeners.get(subscribe);
    if (sharedListener && !(sharedListener.consumers instanceof Map)) {
      try {
        sharedListener.unsubscribe();
      } catch (error) {
        api.logger.warn(
          `anchorclaw: failed to replace stale transcript listener (${error instanceof Error ? error.message : String(error)})`,
        );
      } finally {
        sharedSessionDeltaListeners.delete(subscribe);
        sharedListener = undefined;
      }
    }
    if (!sharedListener) {
      const consumers = new Map<object, (update: SessionTranscriptUpdate) => void>();
      const unsubscribe = subscribe((update: SessionTranscriptUpdate) => {
        const activeConsumer = Array.from(consumers.values()).at(-1);
        activeConsumer?.(update);
      });
      sharedListener = { consumers, unsubscribe };
      sharedSessionDeltaListeners.set(subscribe, sharedListener);
    }
    sharedListener.consumers.set(listenerOwner, consumeUpdate);
    ctx.sessionDelta.unsubscribe = () => {
      const activeListener = sharedSessionDeltaListeners.get(subscribe);
      if (!activeListener || !activeListener.consumers.delete(listenerOwner)) {
        return;
      }
      if (activeListener.consumers.size > 0) {
        return;
      }
      sharedSessionDeltaListeners.delete(subscribe);
      activeListener.unsubscribe();
    };
  };

  const cleanupSessionDelta = () => {
    ctx.sessionDelta.closed = true;
    if (ctx.sessionDelta.timer) {
      clearTimeout(ctx.sessionDelta.timer);
      ctx.sessionDelta.timer = null;
    }
    ctx.sessionDelta.pendingByPath.clear();
    ctx.sessionDelta.retryAttemptsByTarget.clear();
    ctx.sessionDelta.stateByPath.clear();
    if (ctx.sessionDelta.unsubscribe) {
      try {
        ctx.sessionDelta.unsubscribe();
      } finally {
        ctx.sessionDelta.unsubscribe = null;
      }
    }
  };

  return {
    ensureSessionsIndexBootstrapped,
    ensureSessionDeltaListener,
    cleanupSessionDelta,
  };
}
