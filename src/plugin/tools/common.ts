import type { PluginRuntimeContext } from "../runtime-context.js";
import {
  resolveRuntimeWorkspaceTarget,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "../runtime-workspace.js";

export type ToolRegistrationParams = {
  ctx: PluginRuntimeContext;
  refreshPromptCache: (options?: { force?: boolean }) => Promise<void>;
  ensureSessionsIndexBootstrapped: () => Promise<void>;
  ensureStartupBootstrap?: () => Promise<void>;
};

function buildToolUnavailableResponse(error: string): {
  content: { type: "text"; text: string }[];
  details: { disabled: true; error: string };
} {
  return {
    content: [{ type: "text", text: `anchorclaw: tool unavailable (${error})` }],
    details: { disabled: true, error },
  };
}

export function getToolUnavailableResponse(ctx: PluginRuntimeContext):
  | { content: { type: "text"; text: string }[]; details: { disabled: true; error: string } }
  | null {
  if (ctx.disabledReason) {
    return {
      content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
      details: { disabled: true, error: ctx.disabledReason },
    };
  }
  const durableOverall = ctx.durableState?.overall;
  if (durableOverall === "pending" || durableOverall === "blocked") {
    const reason = ctx.durableState?.reason ?? ctx.startupCriticalFailure ?? "durable memory not ready";
    return {
      content: [{ type: "text", text: `anchorclaw: startup blocked (${reason})` }],
      details: { disabled: true, error: reason },
    };
  }
  if (ctx.startupCriticalFailure) {
    return {
      content: [{ type: "text", text: `anchorclaw: startup blocked (${ctx.startupCriticalFailure})` }],
      details: { disabled: true, error: ctx.startupCriticalFailure },
    };
  }
  return null;
}

export async function ensureToolRuntimeReady(
  ctx: PluginRuntimeContext,
  ensureStartupBootstrap?: () => Promise<void>,
): Promise<
  | { content: { type: "text"; text: string }[]; details: { disabled: true; error: string } }
  | null
> {
  if (!ctx.disabledReason && ctx.durableState?.overall === "pending" && typeof ensureStartupBootstrap === "function") {
    await ensureStartupBootstrap();
  }
  return getToolUnavailableResponse(ctx);
}

export function resolveRuntimeToolWorkspace(params: {
  ctx: PluginRuntimeContext;
}):
  | { workspaceDir: string; agentId: string; sessionKey?: string }
  | { content: { type: "text"; text: string }[]; details: { disabled: true; error: string } } {
  const target = resolveRuntimeWorkspaceTarget({ api: params.ctx.api });
  if (!target) {
    return buildToolUnavailableResponse(RUNTIME_WORKSPACE_UNAVAILABLE);
  }
  return target;
}
