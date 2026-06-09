import path from "node:path";

import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";

export type WorkspaceTargetSelector =
  | { mode: "default-agent" }
  | { mode: "agent"; agentId: string }
  | { mode: "all-agent-workspaces" }
  | { mode: "agents"; agentIds: string[] };

export type ResolvedWorkspaceTarget = {
  workspaceDir: string;
  agentIds: string[];
  primaryAgentId: string;
  isDefault: boolean;
  label: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequestedAgentIds(agentIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of agentIds) {
    const agentId = normalizeOptionalString(value);
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    normalized.push(agentId);
  }
  return normalized;
}

function buildWorkspaceLabel(agentIds: readonly string[]): string {
  if (agentIds.length <= 1) {
    return `agent ${agentIds[0] ?? "unknown"}`;
  }
  return `agents ${agentIds.join(", ")}`;
}

function assertConfiguredAgents(runtimeConfig: OpenClawRuntimeConfig, agentIds: readonly string[]): void {
  const knownAgentIds = new Set(listAgentIds(runtimeConfig));
  const unknown = agentIds.filter((agentId) => !knownAgentIds.has(agentId));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(
    `Agent ${JSON.stringify(unknown[0])} is not defined in OpenClaw config. Known agents: ${[...knownAgentIds].join(", ")}.`,
  );
}

function groupResolvedWorkspaceTargets(params: {
  runtimeConfig: OpenClawRuntimeConfig;
  agentIds: readonly string[];
}): ResolvedWorkspaceTarget[] {
  const defaultAgentId = resolveDefaultAgentId(params.runtimeConfig);
  const grouped = new Map<string, ResolvedWorkspaceTarget>();

  for (const agentId of params.agentIds) {
    const workspaceDir = path.resolve(resolveAgentWorkspaceDir(params.runtimeConfig, agentId));
    const existing = grouped.get(workspaceDir);
    if (existing) {
      existing.agentIds.push(agentId);
      existing.isDefault = existing.isDefault || agentId === defaultAgentId;
      continue;
    }
    grouped.set(workspaceDir, {
      workspaceDir,
      agentIds: [agentId],
      primaryAgentId: agentId,
      isDefault: agentId === defaultAgentId,
      label: buildWorkspaceLabel([agentId]),
    });
  }

  for (const target of grouped.values()) {
    target.label = buildWorkspaceLabel(target.agentIds);
  }

  return Array.from(grouped.values());
}

export function resolveWorkspaceTargets(params: {
  runtimeConfig: OpenClawRuntimeConfig;
  selector: WorkspaceTargetSelector;
}): ResolvedWorkspaceTarget[] {
  const { runtimeConfig, selector } = params;
  if (selector.mode === "default-agent") {
    const defaultAgentId = resolveDefaultAgentId(runtimeConfig);
    return groupResolvedWorkspaceTargets({
      runtimeConfig,
      agentIds: [defaultAgentId],
    });
  }

  if (selector.mode === "agent") {
    const agentId = normalizeOptionalString(selector.agentId);
    if (!agentId) {
      throw new Error("Agent id is required.");
    }
    assertConfiguredAgents(runtimeConfig, [agentId]);
    return groupResolvedWorkspaceTargets({
      runtimeConfig,
      agentIds: [agentId],
    });
  }

  if (selector.mode === "all-agent-workspaces") {
    return groupResolvedWorkspaceTargets({
      runtimeConfig,
      agentIds: listAgentIds(runtimeConfig),
    });
  }

  const requestedAgentIds = normalizeRequestedAgentIds(selector.agentIds);
  if (requestedAgentIds.length === 0) {
    throw new Error("At least one agent id is required.");
  }
  assertConfiguredAgents(runtimeConfig, requestedAgentIds);
  return groupResolvedWorkspaceTargets({
    runtimeConfig,
    agentIds: requestedAgentIds,
  });
}

export function resolveAgentWorkspacePeerIds(params: {
  runtimeConfig: OpenClawRuntimeConfig;
  agentId: string;
}): string[] {
  const agentId = normalizeOptionalString(params.agentId);
  if (!agentId) {
    throw new Error("Agent id is required.");
  }
  assertConfiguredAgents(params.runtimeConfig, [agentId]);

  const target = groupResolvedWorkspaceTargets({
    runtimeConfig: params.runtimeConfig,
    agentIds: listAgentIds(params.runtimeConfig),
  }).find((candidate) => candidate.agentIds.includes(agentId));

  if (!target) {
    throw new Error(`Unable to resolve workspace peers for agent ${JSON.stringify(agentId)}.`);
  }
  return [...target.agentIds];
}
