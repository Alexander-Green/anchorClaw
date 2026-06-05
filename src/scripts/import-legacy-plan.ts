import path from "node:path";

import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";

import { resolveWorkspaceTargets } from "../workspace-targets.js";

export type AnchorClawImportOptions = {
  defaultAgent?: boolean;
  agent?: string;
  allAgentWorkspaces?: boolean;
  sourceDir?: string;
  apply?: boolean;
  keepFiles?: boolean;
  nonInteractive?: boolean;
};

export type PlannedAnchorClawImportTarget = {
  selector: "default-agent" | "agent" | "all-agent-workspaces";
  label: string;
  sourceDir: string;
  targetWorkspaceDir: string;
  agentId?: string;
  agentIds: string[];
  sessionKey?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireSingleSelector(opts: AnchorClawImportOptions): {
  selector: PlannedAnchorClawImportTarget["selector"];
  agentId?: string;
} {
  const agentId = normalizeOptionalString(opts.agent);
  const selectors: PlannedAnchorClawImportTarget["selector"][] = [];
  if (opts.defaultAgent) {
    selectors.push("default-agent");
  }
  if (agentId) {
    selectors.push("agent");
  }
  if (opts.allAgentWorkspaces) {
    selectors.push("all-agent-workspaces");
  }

  if (selectors.length === 0) {
    throw new Error(
      "Choose one import target: --default-agent, --agent <id>, or --all-agent-workspaces.",
    );
  }
  if (selectors.length > 1) {
    throw new Error(
      "Choose only one import target: --default-agent, --agent <id>, and --all-agent-workspaces are mutually exclusive.",
    );
  }
  return {
    selector: selectors[0]!,
    agentId,
  };
}

function resolveTargetSessionKey(params: {
  runtimeAgentId?: string;
  runtimeSessionKey?: string;
  agentIds: readonly string[];
}): string | undefined {
  const runtimeAgentId = normalizeOptionalString(params.runtimeAgentId);
  const runtimeSessionKey = normalizeOptionalString(params.runtimeSessionKey);
  if (!runtimeAgentId || !runtimeSessionKey) {
    return undefined;
  }
  return params.agentIds.includes(runtimeAgentId) ? runtimeSessionKey : undefined;
}

function buildTargetLabel(params: {
  selector: PlannedAnchorClawImportTarget["selector"];
  agentIds: readonly string[];
}): string {
  if (params.selector === "default-agent") {
    return params.agentIds[0]
      ? `default agent ${params.agentIds[0]}`
      : "default agent";
  }
  if (params.selector === "agent") {
    return `agent ${params.agentIds[0] ?? "unknown"}`;
  }
  if (params.agentIds.length === 1) {
    return `agent ${params.agentIds[0]}`;
  }
  return `agents ${params.agentIds.join(", ")}`;
}

function resolveSourceDir(sourceDir: string | undefined, targetWorkspaceDir: string): string {
  return path.resolve(sourceDir ?? targetWorkspaceDir);
}

function ensureRuntimeConfigForSelector(
  runtimeConfig: OpenClawRuntimeConfig | undefined,
  selector: PlannedAnchorClawImportTarget["selector"],
): OpenClawRuntimeConfig {
  if (runtimeConfig) {
    return runtimeConfig;
  }
  throw new Error(
    selector === "all-agent-workspaces"
      ? "OpenClaw runtime config is unavailable; --all-agent-workspaces cannot be resolved."
      : "OpenClaw runtime config is unavailable; this agent target cannot be resolved safely.",
  );
}

export function planAnchorClawImportTargets(params: {
  opts: AnchorClawImportOptions;
  runtimeConfig?: OpenClawRuntimeConfig;
  runtimeAgentId?: string;
  runtimeSessionKey?: string;
}): PlannedAnchorClawImportTarget[] {
  const { selector, agentId } = requireSingleSelector(params.opts);
  const sourceDirOverride = normalizeOptionalString(params.opts.sourceDir);

  if (sourceDirOverride && selector === "all-agent-workspaces") {
    throw new Error("--source-dir cannot be combined with --all-agent-workspaces.");
  }

  if (selector === "default-agent") {
    const runtimeConfig = ensureRuntimeConfigForSelector(params.runtimeConfig, selector);
    const [target] = resolveWorkspaceTargets({
      runtimeConfig,
      selector: { mode: "default-agent" },
    });
    return [
      {
        selector,
        label: buildTargetLabel({
          selector,
          agentIds: target.agentIds,
        }),
        sourceDir: resolveSourceDir(sourceDirOverride, target.workspaceDir),
        targetWorkspaceDir: target.workspaceDir,
        agentId: target.primaryAgentId,
        agentIds: target.agentIds,
        sessionKey: resolveTargetSessionKey({
          runtimeAgentId: params.runtimeAgentId,
          runtimeSessionKey: params.runtimeSessionKey,
          agentIds: target.agentIds,
        }),
      },
    ];
  }

  if (selector === "agent") {
    const runtimeConfig = ensureRuntimeConfigForSelector(params.runtimeConfig, selector);
    const resolvedAgentId = agentId!;
    const [target] = resolveWorkspaceTargets({
      runtimeConfig,
      selector: { mode: "agent", agentId: resolvedAgentId },
    });
    return [
      {
        selector,
        label: buildTargetLabel({
          selector,
          agentIds: target.agentIds,
        }),
        sourceDir: resolveSourceDir(sourceDirOverride, target.workspaceDir),
        targetWorkspaceDir: target.workspaceDir,
        agentId: target.primaryAgentId,
        agentIds: target.agentIds,
        sessionKey: resolveTargetSessionKey({
          runtimeAgentId: params.runtimeAgentId,
          runtimeSessionKey: params.runtimeSessionKey,
          agentIds: target.agentIds,
        }),
      },
    ];
  }

  const runtimeConfig = ensureRuntimeConfigForSelector(params.runtimeConfig, selector);
  return resolveWorkspaceTargets({
    runtimeConfig,
    selector: { mode: "all-agent-workspaces" },
  }).map((target) => ({
    selector,
    label: buildTargetLabel({
      selector,
      agentIds: target.agentIds,
    }),
    sourceDir: target.workspaceDir,
    targetWorkspaceDir: target.workspaceDir,
    agentId: target.primaryAgentId,
    agentIds: target.agentIds,
    sessionKey: resolveTargetSessionKey({
      runtimeAgentId: params.runtimeAgentId,
      runtimeSessionKey: params.runtimeSessionKey,
      agentIds: target.agentIds,
    }),
  }));
}
