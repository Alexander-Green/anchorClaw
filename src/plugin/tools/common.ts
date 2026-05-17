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
  if (ctx.startupCriticalFailure) {
    return {
      content: [{ type: "text", text: `anchorclaw: startup blocked (${ctx.startupCriticalFailure})` }],
      details: { disabled: true, error: ctx.startupCriticalFailure },
    };
  }
  return null;
}
