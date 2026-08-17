import type { OpenClawPluginApi } from "../api.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceTargetFromScope,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";
import type { PromptMemoryRuntime } from "./prompt-cache.js";

const DURABLE_MEMORY_UNAVAILABLE_NOTICE = [
  "[AnchorClaw durable memory is unavailable for the current workspace.]",
  "Do not treat missing durable memory as proof that no memory exists.",
].join("\n");

type DurablePromptHookContext = {
  workspaceDir?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
};

export function registerDurablePromptHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  getPromptMemoryLines: PromptMemoryRuntime["getPromptMemoryLines"];
  ensureStartupBootstrap?: () => Promise<void>;
}) {
  const { api, ctx, getPromptMemoryLines, ensureStartupBootstrap } = params;
  const handler = async (_event: unknown, hookContext?: DurablePromptHookContext) => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }

    try {
      if (
        (ctx.durableState?.overall === "pending" ||
          (ctx.durableState?.overall === "blocked" &&
            ctx.durableState?.import === "failed_retryable")) &&
        typeof ensureStartupBootstrap === "function"
      ) {
        await ensureStartupBootstrap();
        if (String(ctx.durableState.overall) !== "ready") {
          return undefined;
        }
      } else {
        await ctx.ensureReady();
      }
      const runtimeConfig = api.runtime.config.current();
      const workspaceTarget = resolveRuntimeWorkspaceTargetFromScope({
        runtimeConfig,
        workspaceDir: hookContext?.workspaceDir,
        agentId: hookContext?.agentId,
        sessionKey: hookContext?.sessionKey,
        sessionId: hookContext?.sessionId,
      });
      if (!workspaceTarget) {
        throw new Error(RUNTIME_WORKSPACE_UNAVAILABLE);
      }
      const lines = await getPromptMemoryLines(workspaceTarget);
      if (lines.length === 0) {
        return undefined;
      }
      return {
        prependSystemContext: lines.join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: durable prompt injection failed (${message})`);
      return {
        prependSystemContext: DURABLE_MEMORY_UNAVAILABLE_NOTICE,
      };
    }
  };

  if (typeof api.on !== "function") {
    return;
  }
  api.on("before_prompt_build", handler, {
    name: "anchorclaw-durable-injection",
  });
}
