import type { PluginRuntimeContext } from "../runtime-context.js";

export type ToolRegistrationParams = {
  ctx: PluginRuntimeContext;
  refreshPromptCache: () => void;
  ensureSessionsIndexBootstrapped: () => Promise<void>;
};

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
