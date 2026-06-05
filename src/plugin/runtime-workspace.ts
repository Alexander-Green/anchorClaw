import type { OpenClawPluginApi } from "../api.js";
import { resolveWorkspaceTargets } from "../workspace-targets.js";

export const RUNTIME_WORKSPACE_UNAVAILABLE = "runtime_workspace_unavailable";

export type RuntimeWorkspaceTarget = {
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveRuntimeWorkspaceTarget(params: {
  api: OpenClawPluginApi;
  agentId?: string;
  sessionKey?: string;
}): RuntimeWorkspaceTarget | undefined {
  const runtimeConfig =
    typeof (params.api as any)?.runtime?.config?.current === "function"
      ? (params.api as any).runtime.config.current()
      : undefined;
  const runtimeAgentId = normalizeOptionalString(params.agentId) ?? normalizeOptionalString((params.api as any)?.runtime?.agentId);
  const runtimeSessionKey =
    normalizeOptionalString(params.sessionKey) ?? normalizeOptionalString((params.api as any)?.runtime?.sessionKey);

  if (!runtimeConfig || !runtimeAgentId) {
    return undefined;
  }

  try {
    const [target] = resolveWorkspaceTargets({
      runtimeConfig: runtimeConfig as any,
      selector: { mode: "agent", agentId: runtimeAgentId },
    });
    if (!target) {
      return undefined;
    }
    return {
      workspaceDir: target.workspaceDir,
      agentId: target.primaryAgentId,
      sessionKey: target.agentIds.includes(runtimeAgentId) ? runtimeSessionKey : undefined,
    };
  } catch {
    return undefined;
  }
}
