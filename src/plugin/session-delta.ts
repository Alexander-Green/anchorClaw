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
import { sessionPathForFile } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import fs from "node:fs/promises";

const SESSION_DELTA_DEBOUNCE_MS = 5_000;

function resolveSessionAgentId(lookup: string): string | null {
  const parts = lookup.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "sessions") {
    return null;
  }
  return parts[1]?.trim() || null;
}

export type SessionDeltaRuntime = {
  ensureSessionsIndexBootstrapped: () => Promise<void>;
  ensureSessionDeltaListener: () => void;
  cleanupSessionDelta: () => void;
};

export function createSessionDeltaRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}): SessionDeltaRuntime {
  const { api, ctx } = params;

  const ensureSessionsIndexBootstrapped = async () => {
    if (!ctx.cfg) {
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      return;
    }
    if (ctx.sessionsIndex.bootstrapped) {
      return;
    }
    if (ctx.sessionsIndex.bootstrapPromise) {
      await ctx.sessionsIndex.bootstrapPromise;
      return;
    }
    ctx.sessionsIndex.bootstrapPromise = (async () => {
      try {
        await ctx.ensureReady();
        const workspaceTarget = resolveRuntimeWorkspaceTarget({ api });
        if (!workspaceTarget) {
          throw new Error(RUNTIME_WORKSPACE_UNAVAILABLE);
        }
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          workspaceDir: workspaceTarget.workspaceDir,
          agentId: workspaceTarget.agentId,
          sessionKey: workspaceTarget.sessionKey,
          configuredExternalId: ctx.cfg?.identity?.externalId,
        });
        const currentAgentId = String((api as any)?.runtime?.agentId ?? "main");
        if ((ctx.cfg?.sessions?.visibility ?? "current") === "visible") {
          const visibleAgentIds = await ctx.listVisibleAgentIds();
          await syncVisibleSessionsIndexDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            agentId: currentAgentId,
            otherAgentIds: visibleAgentIds.filter((agentId) => agentId !== currentAgentId),
          });
        } else {
          await syncSessionsIndexDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            agentId: currentAgentId,
          });
        }
        ctx.sessionsIndex.bootstrapped = true;
      } catch (error) {
        api.logger.warn(
          `anchorclaw: sessions index bootstrap failed (${error instanceof Error ? error.message : String(error)})`,
        );
      } finally {
        ctx.sessionsIndex.bootstrapPromise = null;
      }
    })();
    await ctx.sessionsIndex.bootstrapPromise;
  };

  const flushSessionDeltaSync = async () => {
    if (ctx.sessionDelta.closed) {
      ctx.sessionDelta.pendingFiles.clear();
      return;
    }
    if (!ctx.cfg) {
      ctx.sessionDelta.pendingFiles.clear();
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      ctx.sessionDelta.pendingFiles.clear();
      return;
    }
    if (ctx.sessionDelta.pendingFiles.size === 0) {
      return;
    }
    if (ctx.sessionDelta.syncInFlight) {
      return;
    }

    const batch = Array.from(ctx.sessionDelta.pendingFiles);
    const sessionDeltaThresholds = resolveSessionDeltaThresholds(ctx.cfg);
    ctx.sessionDelta.pendingFiles.clear();
    const dirtyFiles: string[] = [];
    for (const sessionFile of batch) {
      if (isSessionArchiveArtifactPath(sessionFile)) {
        dirtyFiles.push(sessionFile);
        continue;
      }
      let statSize: number | null = null;
      try {
        const stat = await fs.stat(sessionFile);
        statSize = typeof stat.size === "number" ? stat.size : null;
      } catch {
        // If stat is unavailable, keep previous behavior and allow targeted sync.
        dirtyFiles.push(sessionFile);
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
        dirtyFiles.push(sessionFile);
      }
    }
    if (dirtyFiles.length === 0) {
      return;
    }

    ctx.sessionDelta.syncInFlight = (async () => {
      try {
        api.logger.info(
          `anchorclaw: sessions delta flush start (batch=${batch.length}, dirty=${dirtyFiles.length}, visibility=${ctx.cfg?.sessions?.visibility ?? "current"})`,
        );
        await ctx.ensureReady();
        const workspaceTarget = resolveRuntimeWorkspaceTarget({ api });
        if (!workspaceTarget) {
          throw new Error(RUNTIME_WORKSPACE_UNAVAILABLE);
        }
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          workspaceDir: workspaceTarget.workspaceDir,
          agentId: workspaceTarget.agentId,
          sessionKey: workspaceTarget.sessionKey,
          configuredExternalId: ctx.cfg?.identity?.externalId,
        });
        const currentAgentId = String((api as any)?.runtime?.agentId ?? "main");
        await syncSessionsIndexDb({
          pool: ctx.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: currentAgentId,
          sessionFiles: dirtyFiles,
        });
        for (const sessionFile of dirtyFiles) {
          const state = ctx.sessionDelta.stateByPath.get(sessionFile);
          if (!state) {
            continue;
          }
          ctx.sessionDelta.stateByPath.set(sessionFile, {
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
        api.logger.info(
          `anchorclaw: sessions delta flush done (batch=${batch.length}, dirty=${dirtyFiles.length}, agent=${currentAgentId})`,
        );
      } catch (error) {
        api.logger.warn(
          `anchorclaw: sessions delta sync failed (${error instanceof Error ? error.message : String(error)})`,
        );
      } finally {
        ctx.sessionDelta.syncInFlight = null;
        if (ctx.sessionDelta.pendingFiles.size > 0 && !ctx.sessionDelta.closed && !ctx.sessionDelta.timer) {
          ctx.sessionDelta.timer = setTimeout(() => {
            ctx.sessionDelta.timer = null;
            void flushSessionDeltaSync();
          }, SESSION_DELTA_DEBOUNCE_MS);
        }
      }
    })();

    await ctx.sessionDelta.syncInFlight;
  };

  const scheduleSessionDeltaSync = (sessionFile: string) => {
    const filePath = sessionFile.trim();
    if (!filePath || ctx.sessionDelta.closed) {
      return;
    }
    ctx.sessionDelta.pendingFiles.add(filePath);
    if (ctx.sessionDelta.timer) {
      return;
    }
    ctx.sessionDelta.timer = setTimeout(() => {
      ctx.sessionDelta.timer = null;
      void flushSessionDeltaSync();
    }, SESSION_DELTA_DEBOUNCE_MS);
  };

  const ensureSessionDeltaListener = () => {
    if (!ctx.cfg || ctx.sessionDelta.closed || ctx.sessionDelta.unsubscribe) {
      return;
    }
    if (!resolveSessionsSearchState(ctx.cfg).effective) {
      return;
    }
    const subscribe = (api as any)?.runtime?.events?.onSessionTranscriptUpdate;
    if (typeof subscribe !== "function") {
      api.logger.warn("anchorclaw: runtime.events.onSessionTranscriptUpdate unavailable; sessions delta sync disabled");
      return;
    }
    const currentAgentId = String((api as any)?.runtime?.agentId ?? "main");
    const isRelevantSessionDeltaPath = async (sessionFile: string): Promise<boolean> => {
      if ((ctx.cfg?.sessions?.visibility ?? "current") === "visible") {
        const lookup = normalizeSessionLookupPath(sessionPathForFile(sessionFile));
        const transcriptAgentId = lookup ? resolveSessionAgentId(lookup) : null;
        if (!lookup || !transcriptAgentId) {
          const next = (ctx.sessionDelta.ignoredPathCounts.get(sessionFile) ?? 0) + 1;
          ctx.sessionDelta.ignoredPathCounts.set(sessionFile, next);
          if (next === 1 || next === 5 || next % 20 === 0) {
            api.logger.warn(
              `anchorclaw: ignored session delta update due to unrecognized path (${sessionFile}) [count=${next}]`,
            );
          }
          return false;
        }
        const visibleAgentIds = await ctx.listVisibleAgentIds();
        if (!visibleAgentIds.includes(transcriptAgentId)) {
          const next = (ctx.sessionDelta.ignoredPathCounts.get(lookup) ?? 0) + 1;
          ctx.sessionDelta.ignoredPathCounts.set(lookup, next);
          if (next === 1 || next === 5 || next % 20 === 0) {
            api.logger.warn(
              `anchorclaw: ignored session delta update outside current workspace scope (${lookup}) [count=${next}]`,
            );
          }
          return false;
        }
        const inAgentDir = await isSessionFileForAgent({
          sessionFile,
          agentId: transcriptAgentId,
        });
        if (inAgentDir) {
          return true;
        }
        const next = (ctx.sessionDelta.ignoredPathCounts.get(lookup) ?? 0) + 1;
        ctx.sessionDelta.ignoredPathCounts.set(lookup, next);
        if (next === 1 || next === 5 || next % 20 === 0) {
          api.logger.warn(
            `anchorclaw: ignored session delta update due to unrecognized path (${lookup}) [count=${next}]`,
          );
        }
        return false;
      }
      const inCurrentAgentDir = await isSessionFileForAgent({
        sessionFile,
        agentId: currentAgentId,
      });
      if (!inCurrentAgentDir) {
        const lookup = normalizeSessionLookupPath(sessionPathForFile(sessionFile));
        const logKey = lookup || sessionFile;
        const next = (ctx.sessionDelta.ignoredPathCounts.get(logKey) ?? 0) + 1;
        ctx.sessionDelta.ignoredPathCounts.set(logKey, next);
        if (next === 1 || next === 5 || next % 20 === 0) {
          api.logger.warn(
            `anchorclaw: ignored session delta update outside current visibility (${logKey}) [count=${next}]`,
          );
        }
        return false;
      }
      const lookup = normalizeSessionLookupPath(sessionPathForFile(sessionFile));
      if (!lookup) {
        const next = (ctx.sessionDelta.ignoredPathCounts.get(sessionFile) ?? 0) + 1;
        ctx.sessionDelta.ignoredPathCounts.set(sessionFile, next);
        if (next === 1 || next === 5 || next % 20 === 0) {
          api.logger.warn(
            `anchorclaw: ignored session delta update due to unrecognized path (${sessionFile}) [count=${next}]`,
          );
        }
        return false;
      }
      return true;
    };
    ctx.sessionDelta.unsubscribe = subscribe((update: { sessionFile?: unknown }) => {
      if (ctx.sessionDelta.closed) {
        return;
      }
      const sessionFile = typeof update?.sessionFile === "string" ? update.sessionFile : "";
      if (!sessionFile) {
        return;
      }
      api.logger.info(`anchorclaw: transcript update event received (${sessionFile})`);
      void (async () => {
        if (!(await isRelevantSessionDeltaPath(sessionFile))) {
          return;
        }
        api.logger.info(`anchorclaw: transcript update accepted for delta sync (${sessionFile})`);
        scheduleSessionDeltaSync(sessionFile);
      })();
    });
  };

  const cleanupSessionDelta = () => {
    ctx.sessionDelta.closed = true;
    if (ctx.sessionDelta.timer) {
      clearTimeout(ctx.sessionDelta.timer);
      ctx.sessionDelta.timer = null;
    }
    ctx.sessionDelta.pendingFiles.clear();
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
