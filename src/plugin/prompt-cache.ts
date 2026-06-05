import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import {
  buildPromptMemorySection,
  queryPromptMemoryItems,
} from "../memory/prompt.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceTarget,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";

export type PromptCacheRuntime = {
  refreshPromptCache: (options?: { force?: boolean }) => Promise<void>;
};

export function createPromptCacheRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}): PromptCacheRuntime {
  const { api, ctx } = params;

  const refreshPromptCache = async (options?: { force?: boolean }) => {
    if (!ctx.cfg) {
      ctx.promptCache.lines = null;
      ctx.promptCache.error = ctx.disabledReason ?? "invalid config";
      return;
    }
    if (ctx.promptCache.refreshPromise) {
      if (!options?.force) {
        return ctx.promptCache.refreshPromise;
      }
      await ctx.promptCache.refreshPromise.catch(() => undefined);
    }
    const refreshPromise = (async () => {
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
        const items = await queryPromptMemoryItems({
          pool: ctx.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          limit: 50,
          // MVP: durable injection focuses on facts and notes.
          // TODO: extend prompt injection policy for other types:
          // profile/config/skill/summary/automation (safe ordering + size budgets + canonicalKey conventions).
          types: ["fact", "note"],
        });
        const maxItemsByType = items.reduce<Record<string, number>>((acc, item) => {
          acc[item.type] = (acc[item.type] ?? 0) + 1;
          return acc;
        }, {});
        const durableLines = buildPromptMemorySection({
          items,
          maxTotalChars: 12_000,
          maxTitleChars: 120,
          policy: {
            maxItemsByType,
            defaultMaxItemChars: 2_400,
          },
        });
        ctx.promptCache.lines = durableLines;
        ctx.promptCache.error = null;
      } catch (error) {
        ctx.promptCache.lines = null;
        ctx.promptCache.error = error instanceof Error ? error.message : String(error);
        api.logger.warn(`anchorclaw: prompt cache refresh failed (${ctx.promptCache.error})`);
      } finally {
        ctx.promptCache.refreshPromise = null;
      }
    })();
    ctx.promptCache.refreshPromise = refreshPromise;
    return refreshPromise;
  };

  return { refreshPromptCache };
}
