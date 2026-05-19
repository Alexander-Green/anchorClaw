import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { buildPromptMemorySection, queryPromptMemoryItems } from "../memory/prompt.js";
import { requireConfiguredWorkspaceDir } from "../workspace.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

export type PromptCacheRuntime = {
  refreshPromptCache: () => void;
};

export function createPromptCacheRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}): PromptCacheRuntime {
  const { api, ctx } = params;

  const refreshPromptCache = () => {
    if (!ctx.cfg) {
      ctx.promptCache.lines = null;
      ctx.promptCache.error = ctx.disabledReason ?? "invalid config";
      return;
    }
    if (ctx.promptCache.refreshPromise) {
      return;
    }
    ctx.promptCache.refreshPromise = (async () => {
      try {
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          workspaceDir: requireConfiguredWorkspaceDir(ctx.cfg),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
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
        ctx.promptCache.lines = buildPromptMemorySection({
          items,
          maxTotalChars: 12_000,
          maxTitleChars: 120,
          policy: {
            // MVP: durable injection focuses on facts and notes.
            maxItemsByType: { fact: 6, note: 4 },
            defaultMaxItemChars: 1_200,
          },
        });
        ctx.promptCache.error = null;
      } catch (error) {
        ctx.promptCache.lines = null;
        ctx.promptCache.error = error instanceof Error ? error.message : String(error);
        api.logger.warn(`anchorclaw: prompt cache refresh failed (${ctx.promptCache.error})`);
      } finally {
        ctx.promptCache.refreshPromise = null;
      }
    })();
  };

  return { refreshPromptCache };
}
