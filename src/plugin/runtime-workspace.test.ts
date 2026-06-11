import { describe, expect, it } from "vitest";

import {
  resolveRuntimeWorkspaceResolution,
  resolveRuntimeWorkspaceResolutionFromScope,
  resolveRuntimeWorkspaceTargetFromScope,
  RUNTIME_WORKSPACE_MISMATCH,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";

describe("resolveRuntimeWorkspaceResolutionFromScope", () => {
  it("uses live workspace context when it matches the configured agent workspace", () => {
    const result = resolveRuntimeWorkspaceResolutionFromScope({
      runtimeConfig: {
        agents: {
          list: [{ id: "ops", workspace: "/agents/ops" }],
        },
      } as any,
      workspaceDir: "/agents/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
      sessionId: "session-1",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        workspaceDir: "/agents/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
        sessionId: "session-1",
      },
    });
  });

  it("falls back to configured agent workspace when live workspace context is absent", () => {
    const result = resolveRuntimeWorkspaceResolutionFromScope({
      runtimeConfig: {
        agents: {
          list: [{ id: "ops", workspace: "/agents/ops" }],
        },
      } as any,
      agentId: "ops",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        workspaceDir: "/agents/ops",
        agentId: "ops",
      },
    });
  });

  it("accepts live workspace context when runtime config is unavailable", () => {
    const result = resolveRuntimeWorkspaceResolutionFromScope({
      workspaceDir: "/runtime/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        workspaceDir: "/runtime/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      },
    });
  });

  it("returns a diagnostic mismatch when live workspace and configured workspace disagree", () => {
    const result = resolveRuntimeWorkspaceResolutionFromScope({
      runtimeConfig: {
        agents: {
          list: [{ id: "ops", workspace: "/agents/ops" }],
        },
      } as any,
      workspaceDir: "/runtime/other",
      agentId: "ops",
    });

    expect(result).toEqual({
      ok: false,
      error: RUNTIME_WORKSPACE_MISMATCH,
      reason: "workspace_mismatch",
      agentId: "ops",
      contextWorkspaceDir: "/runtime/other",
      configuredWorkspaceDir: "/agents/ops",
      message: "runtime workspace mismatch for agent ops",
    });
  });

  it("fails closed when neither agent nor workspace can be resolved", () => {
    const result = resolveRuntimeWorkspaceResolutionFromScope({});

    expect(result).toEqual({
      ok: false,
      error: RUNTIME_WORKSPACE_UNAVAILABLE,
      reason: "agent_unavailable",
      message: "runtime agent id is unavailable",
    });
  });
});

describe("resolveRuntimeWorkspaceTargetFromScope", () => {
  it("keeps the legacy target wrapper fail-closed for existing callers", () => {
    expect(
      resolveRuntimeWorkspaceTargetFromScope({
        runtimeConfig: {
          agents: {
            list: [{ id: "ops", workspace: "/agents/ops" }],
          },
        } as any,
        workspaceDir: "/runtime/other",
        agentId: "ops",
      }),
    ).toBeUndefined();
  });
});

describe("resolveRuntimeWorkspaceResolution", () => {
  function buildApi() {
    return {
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:main",
        config: {
          current: () => ({
            agents: {
              list: [
                { id: "main", default: true, workspace: "/agents/main" },
                { id: "qa", workspace: "/agents/qa" },
              ],
            },
          }),
        },
      },
    } as any;
  }

  it("keeps legacy api runtime session fallback when no explicit identity scope is provided", () => {
    const result = resolveRuntimeWorkspaceResolution({ api: buildApi() });

    expect(result).toEqual({
      ok: true,
      target: {
        workspaceDir: "/agents/main",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
  });

  it("does not mix explicit agent scope with global runtime session key", () => {
    const result = resolveRuntimeWorkspaceResolution({
      api: buildApi(),
      workspaceDir: "/agents/qa",
      agentId: "qa",
    });

    expect(result).toEqual({
      ok: true,
      target: {
        workspaceDir: "/agents/qa",
        agentId: "qa",
      },
    });
  });
});
