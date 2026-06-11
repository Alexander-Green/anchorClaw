import path from "node:path";

import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";
import type { OpenClawPluginApi } from "../api.js";
import { resolveWorkspaceTargets } from "../workspace-targets.js";

export const RUNTIME_WORKSPACE_UNAVAILABLE = "runtime_workspace_unavailable";
export const RUNTIME_WORKSPACE_MISMATCH = "runtime_workspace_mismatch";

export type RuntimeWorkspaceTarget = {
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
};

export type RuntimeWorkspaceScopeInput = {
  runtimeConfig?: OpenClawRuntimeConfig;
  workspaceDir?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
};

export type RuntimeWorkspaceResolution =
  | { ok: true; target: RuntimeWorkspaceTarget }
  | {
      ok: false;
      error: typeof RUNTIME_WORKSPACE_UNAVAILABLE | typeof RUNTIME_WORKSPACE_MISMATCH;
      reason:
        | "agent_unavailable"
        | "workspace_unavailable"
        | "agent_unknown"
        | "workspace_mismatch";
      agentId?: string;
      contextWorkspaceDir?: string;
      configuredWorkspaceDir?: string;
      message: string;
    };

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRuntimeConfig(api: OpenClawPluginApi): OpenClawRuntimeConfig | undefined {
  const current = (api as any)?.runtime?.config?.current;
  if (typeof current !== "function") {
    return undefined;
  }
  const cfg = current();
  return cfg && typeof cfg === "object" ? (cfg as OpenClawRuntimeConfig) : undefined;
}

function unavailable(params: Omit<Extract<RuntimeWorkspaceResolution, { ok: false }>, "ok">): RuntimeWorkspaceResolution {
  return { ok: false, ...params };
}

export function resolveRuntimeWorkspaceResolutionFromScope(
  params: RuntimeWorkspaceScopeInput,
): RuntimeWorkspaceResolution {
  const runtimeConfig = params.runtimeConfig;
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const sessionId = normalizeOptionalString(params.sessionId);
  const liveWorkspaceDir = normalizeOptionalString(params.workspaceDir);

  if (!agentId) {
    return unavailable({
      error: RUNTIME_WORKSPACE_UNAVAILABLE,
      reason: "agent_unavailable",
      message: "runtime agent id is unavailable",
    });
  }

  if (!runtimeConfig) {
    if (!liveWorkspaceDir) {
      return unavailable({
        error: RUNTIME_WORKSPACE_UNAVAILABLE,
        reason: "workspace_unavailable",
        agentId,
        message: "runtime config and live workspace dir are unavailable",
      });
    }
    return {
      ok: true,
      target: {
        workspaceDir: path.resolve(liveWorkspaceDir),
        agentId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    };
  }

  try {
    const [target] = resolveWorkspaceTargets({
      runtimeConfig,
      selector: { mode: "agent", agentId },
    });
    if (!target) {
      return unavailable({
        error: RUNTIME_WORKSPACE_UNAVAILABLE,
        reason: "agent_unknown",
        agentId,
        message: `runtime agent ${JSON.stringify(agentId)} did not resolve to a workspace`,
      });
    }

    const configuredWorkspaceDir = path.resolve(target.workspaceDir);
    const resolvedLiveWorkspaceDir = liveWorkspaceDir ? path.resolve(liveWorkspaceDir) : undefined;
    if (resolvedLiveWorkspaceDir && resolvedLiveWorkspaceDir !== configuredWorkspaceDir) {
      return unavailable({
        error: RUNTIME_WORKSPACE_MISMATCH,
        reason: "workspace_mismatch",
        agentId,
        contextWorkspaceDir: resolvedLiveWorkspaceDir,
        configuredWorkspaceDir,
        message: `runtime workspace mismatch for agent ${agentId}`,
      });
    }

    return {
      ok: true,
      target: {
        workspaceDir: resolvedLiveWorkspaceDir ?? configuredWorkspaceDir,
        agentId: target.primaryAgentId,
        ...(target.agentIds.includes(agentId) && sessionKey ? { sessionKey } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    };
  } catch (error) {
    return unavailable({
      error: RUNTIME_WORKSPACE_UNAVAILABLE,
      reason: "agent_unknown",
      agentId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveRuntimeWorkspaceTargetFromScope(
  params: RuntimeWorkspaceScopeInput,
): RuntimeWorkspaceTarget | undefined {
  const resolution = resolveRuntimeWorkspaceResolutionFromScope(params);
  return resolution.ok ? resolution.target : undefined;
}

export function resolveRuntimeWorkspaceResolution(params: {
  api: OpenClawPluginApi;
  runtimeConfig?: OpenClawRuntimeConfig;
  getRuntimeConfig?: () => OpenClawRuntimeConfig | undefined;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}): RuntimeWorkspaceResolution {
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const explicitSessionKey = normalizeOptionalString(params.sessionKey);
  const explicitSessionId = normalizeOptionalString(params.sessionId);
  const explicitWorkspaceDir = normalizeOptionalString(params.workspaceDir);
  const hasExplicitIdentityScope = Boolean(explicitAgentId || explicitSessionId);
  return resolveRuntimeWorkspaceResolutionFromScope({
    runtimeConfig: params.runtimeConfig ?? params.getRuntimeConfig?.() ?? resolveRuntimeConfig(params.api),
    workspaceDir: explicitWorkspaceDir,
    agentId: explicitAgentId ?? normalizeOptionalString((params.api as any)?.runtime?.agentId),
    sessionKey:
      explicitSessionKey ??
      (hasExplicitIdentityScope ? undefined : normalizeOptionalString((params.api as any)?.runtime?.sessionKey)),
    sessionId: explicitSessionId,
  });
}

export function resolveRuntimeWorkspaceTarget(params: {
  api: OpenClawPluginApi;
  runtimeConfig?: OpenClawRuntimeConfig;
  getRuntimeConfig?: () => OpenClawRuntimeConfig | undefined;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}): RuntimeWorkspaceTarget | undefined {
  const resolution = resolveRuntimeWorkspaceResolution(params);
  return resolution.ok ? resolution.target : undefined;
}
