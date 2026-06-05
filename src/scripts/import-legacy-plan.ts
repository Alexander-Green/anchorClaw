import path from "node:path";

import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";

import type { AnchorClawConfig } from "../config.js";

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
  deprecatedWorkspaceDirFallback: boolean;
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
  deprecatedWorkspaceDirFallback: boolean;
}): string {
  if (params.selector === "default-agent") {
    const fallbackSuffix = params.deprecatedWorkspaceDirFallback
      ? " (deprecated anchorclaw.workspaceDir fallback)"
      : "";
    return params.agentIds[0]
      ? `default agent ${params.agentIds[0]}${fallbackSuffix}`
      : `default agent${fallbackSuffix}`;
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

function assertConfiguredAgent(runtimeConfig: OpenClawRuntimeConfig, agentId: string): void {
  const agentIds = listAgentIds(runtimeConfig);
  if (agentIds.includes(agentId)) {
    return;
  }
  throw new Error(
    `Agent ${JSON.stringify(agentId)} is not defined in OpenClaw config. Known agents: ${agentIds.join(", ")}.`,
  );
}

export function planAnchorClawImportTargets(params: {
  cfg: AnchorClawConfig;
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
    if (!params.runtimeConfig) {
      const targetWorkspaceDir = path.resolve(params.cfg.workspaceDir);
      return [
        {
          selector,
          label: buildTargetLabel({
            selector,
            agentIds: [],
            deprecatedWorkspaceDirFallback: true,
          }),
          sourceDir: resolveSourceDir(sourceDirOverride, targetWorkspaceDir),
          targetWorkspaceDir,
          agentId: undefined,
          agentIds: [],
          sessionKey: undefined,
          deprecatedWorkspaceDirFallback: true,
        },
      ];
    }
    const defaultAgentId = resolveDefaultAgentId(params.runtimeConfig);
    const targetWorkspaceDir = path.resolve(resolveAgentWorkspaceDir(params.runtimeConfig, defaultAgentId));
    return [
      {
        selector,
        label: buildTargetLabel({
          selector,
          agentIds: [defaultAgentId],
          deprecatedWorkspaceDirFallback: false,
        }),
        sourceDir: resolveSourceDir(sourceDirOverride, targetWorkspaceDir),
        targetWorkspaceDir,
        agentId: defaultAgentId,
        agentIds: [defaultAgentId],
        sessionKey: resolveTargetSessionKey({
          runtimeAgentId: params.runtimeAgentId,
          runtimeSessionKey: params.runtimeSessionKey,
          agentIds: [defaultAgentId],
        }),
        deprecatedWorkspaceDirFallback: false,
      },
    ];
  }

  if (selector === "agent") {
    const runtimeConfig = ensureRuntimeConfigForSelector(params.runtimeConfig, selector);
    const resolvedAgentId = agentId!;
    assertConfiguredAgent(runtimeConfig, resolvedAgentId);
    const targetWorkspaceDir = path.resolve(resolveAgentWorkspaceDir(runtimeConfig, resolvedAgentId));
    return [
      {
        selector,
        label: buildTargetLabel({
          selector,
          agentIds: [resolvedAgentId],
          deprecatedWorkspaceDirFallback: false,
        }),
        sourceDir: resolveSourceDir(sourceDirOverride, targetWorkspaceDir),
        targetWorkspaceDir,
        agentId: resolvedAgentId,
        agentIds: [resolvedAgentId],
        sessionKey: resolveTargetSessionKey({
          runtimeAgentId: params.runtimeAgentId,
          runtimeSessionKey: params.runtimeSessionKey,
          agentIds: [resolvedAgentId],
        }),
        deprecatedWorkspaceDirFallback: false,
      },
    ];
  }

  const runtimeConfig = ensureRuntimeConfigForSelector(params.runtimeConfig, selector);
  const groupedTargets = new Map<string, string[]>();
  for (const currentAgentId of listAgentIds(runtimeConfig)) {
    const targetWorkspaceDir = path.resolve(resolveAgentWorkspaceDir(runtimeConfig, currentAgentId));
    const existing = groupedTargets.get(targetWorkspaceDir);
    if (existing) {
      existing.push(currentAgentId);
    } else {
      groupedTargets.set(targetWorkspaceDir, [currentAgentId]);
    }
  }

  return Array.from(groupedTargets.entries()).map(([targetWorkspaceDir, agentIds]) => ({
    selector,
    label: buildTargetLabel({
      selector,
      agentIds,
      deprecatedWorkspaceDirFallback: false,
    }),
    sourceDir: targetWorkspaceDir,
    targetWorkspaceDir,
    agentId: agentIds[0],
    agentIds,
    sessionKey: resolveTargetSessionKey({
      runtimeAgentId: params.runtimeAgentId,
      runtimeSessionKey: params.runtimeSessionKey,
      agentIds,
    }),
    deprecatedWorkspaceDirFallback: false,
  }));
}
