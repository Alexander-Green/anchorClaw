import { describe, expect, it } from "vitest";

import { planAnchorClawImportTargets } from "./import-legacy-plan.js";

describe("planAnchorClawImportTargets", () => {
  const cfg = {
    workspaceDir: "/cfg/workspace",
    postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
  } as any;

  it("plans a default-agent import from an external source directory", () => {
    const targets = planAnchorClawImportTargets({
      cfg,
      opts: {
        defaultAgent: true,
        sourceDir: "/legacy/export",
      },
      runtimeConfig: {
        agents: {
          list: [{ id: "main", default: true, workspace: "/agents/main" }],
        },
      } as any,
      runtimeAgentId: "main",
      runtimeSessionKey: "agent:main:test",
    });

    expect(targets).toEqual([
      {
        selector: "default-agent",
        label: "default agent main",
        sourceDir: "/legacy/export",
        targetWorkspaceDir: "/agents/main",
        agentId: "main",
        agentIds: ["main"],
        sessionKey: "agent:main:test",
        deprecatedWorkspaceDirFallback: false,
      },
    ]);
  });

  it("dedupes shared workspaces for --all-agent-workspaces", () => {
    const targets = planAnchorClawImportTargets({
      cfg,
      opts: {
        allAgentWorkspaces: true,
      },
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/shared" },
            { id: "ops", workspace: "/agents/shared" },
            { id: "qa", workspace: "/agents/qa" },
          ],
        },
      } as any,
      runtimeAgentId: "ops",
      runtimeSessionKey: "agent:ops:test",
    });

    expect(targets).toEqual([
      {
        selector: "all-agent-workspaces",
        label: "agents main, ops",
        sourceDir: "/agents/shared",
        targetWorkspaceDir: "/agents/shared",
        agentId: "main",
        agentIds: ["main", "ops"],
        sessionKey: "agent:ops:test",
        deprecatedWorkspaceDirFallback: false,
      },
      {
        selector: "all-agent-workspaces",
        label: "agent qa",
        sourceDir: "/agents/qa",
        targetWorkspaceDir: "/agents/qa",
        agentId: "qa",
        agentIds: ["qa"],
        sessionKey: undefined,
        deprecatedWorkspaceDirFallback: false,
      },
    ]);
  });

  it("falls back to anchorclaw.workspaceDir for --default-agent when runtime config is unavailable", () => {
    const targets = planAnchorClawImportTargets({
      cfg,
      opts: {
        defaultAgent: true,
      },
    });

    expect(targets).toEqual([
      {
        selector: "default-agent",
        label: "default agent (deprecated anchorclaw.workspaceDir fallback)",
        sourceDir: "/cfg/workspace",
        targetWorkspaceDir: "/cfg/workspace",
        agentId: undefined,
        agentIds: [],
        sessionKey: undefined,
        deprecatedWorkspaceDirFallback: true,
      },
    ]);
  });

  it("rejects mutually exclusive selectors", () => {
    expect(() =>
      planAnchorClawImportTargets({
        cfg,
        opts: {
          defaultAgent: true,
          allAgentWorkspaces: true,
        },
      }),
    ).toThrow(/mutually exclusive/i);
  });

  it("rejects --source-dir with --all-agent-workspaces", () => {
    expect(() =>
      planAnchorClawImportTargets({
        cfg,
        opts: {
          allAgentWorkspaces: true,
          sourceDir: "/legacy/export",
        },
        runtimeConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/agents/main" }],
          },
        } as any,
      }),
    ).toThrow(/cannot be combined/i);
  });

  it("rejects unknown explicit agents", () => {
    expect(() =>
      planAnchorClawImportTargets({
        cfg,
        opts: {
          agent: "ghost",
        },
        runtimeConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/agents/main" }],
          },
        } as any,
      }),
    ).toThrow(/Known agents: main/);
  });
});
