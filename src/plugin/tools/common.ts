import type { PluginRuntimeContext } from "../runtime-context.js";
import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";
import {
  resolveRuntimeWorkspaceResolution,
  type RuntimeWorkspaceResolution,
} from "../runtime-workspace.js";
import type { SessionIndexBootstrapTarget } from "../session-delta.js";

export type ToolRegistrationParams = {
  ctx: PluginRuntimeContext;
  invalidatePromptMemory: (params: { workspaceDir: string }) => void;
  ensureSessionsIndexBootstrapped: (target?: SessionIndexBootstrapTarget) => Promise<void>;
  ensureStartupBootstrap?: () => Promise<void>;
};

function buildToolUnavailableResponse(
  error: string,
  details?: Record<string, unknown>,
): {
  content: { type: "text"; text: string }[];
  details: { disabled: true; error: string } & Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: `anchorclaw: tool unavailable (${error})` }],
    details: { disabled: true, error, ...(details ?? {}) },
  };
}

function warnRuntimeWorkspaceResolutionFailure(
  ctx: PluginRuntimeContext,
  failure: Extract<RuntimeWorkspaceResolution, { ok: false }>,
): void {
  const pathDetails =
    failure.contextWorkspaceDir || failure.configuredWorkspaceDir
      ? ` (context=${failure.contextWorkspaceDir ?? "unknown"}, configured=${failure.configuredWorkspaceDir ?? "unknown"})`
      : "";
  const agentDetails = failure.agentId ? ` for agent ${failure.agentId}` : "";
  ctx.api.logger.warn(
    `anchorclaw: runtime workspace resolution failed${agentDetails} (${failure.reason}: ${failure.message})${pathDetails}`,
  );
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
  const startupNeedsRun =
    ctx.durableState?.overall === "pending" ||
    (ctx.durableState?.overall === "blocked" &&
      ctx.durableState?.import === "failed_retryable");
  if (!ctx.disabledReason && startupNeedsRun && typeof ensureStartupBootstrap === "function") {
    await ensureStartupBootstrap();
  }
  return getToolUnavailableResponse(ctx);
}

export function resolveRuntimeToolWorkspace(params: {
  ctx: PluginRuntimeContext;
  runtimeConfig?: OpenClawRuntimeConfig;
  getRuntimeConfig?: () => OpenClawRuntimeConfig | undefined;
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}):
  | { workspaceDir: string; agentId: string; sessionKey?: string; sessionId?: string }
  | { content: { type: "text"; text: string }[]; details: { disabled: true; error: string } } {
  const resolution = resolveRuntimeWorkspaceResolution({
    api: params.ctx.api,
    runtimeConfig: params.runtimeConfig,
    getRuntimeConfig: params.getRuntimeConfig,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (!resolution.ok) {
    warnRuntimeWorkspaceResolutionFailure(params.ctx, resolution);
    return buildToolUnavailableResponse(resolution.error, {
      reason: resolution.reason,
      ...(resolution.agentId ? { agentId: resolution.agentId } : {}),
      ...(resolution.contextWorkspaceDir ? { contextWorkspaceDir: resolution.contextWorkspaceDir } : {}),
      ...(resolution.configuredWorkspaceDir ? { configuredWorkspaceDir: resolution.configuredWorkspaceDir } : {}),
    });
  }
  return resolution.target;
}
