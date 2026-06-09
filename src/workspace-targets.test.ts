import { describe, expect, it } from "vitest";

import {
  resolveAgentWorkspacePeerIds,
  resolveWorkspaceTargets,
} from "./workspace-targets.js";

describe("resolveWorkspaceTargets", () => {
  it("resolves implicit main as the default agent", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {} as any,
      selector: { mode: "default-agent" },
    });

    expect(targets).toEqual([
      {
        workspaceDir: expect.stringMatching(/workspace$/),
        agentIds: ["main"],
        primaryAgentId: "main",
        isDefault: true,
        label: "agent main",
      },
    ]);
  });

  it("uses the first configured agent as default when no explicit default is set", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {
        agents: {
          list: [
            { id: "writer", workspace: "/agents/writer" },
            { id: "ops", workspace: "/agents/ops" },
          ],
        },
      } as any,
      selector: { mode: "default-agent" },
    });

    expect(targets).toEqual([
      {
        workspaceDir: "/agents/writer",
        agentIds: ["writer"],
        primaryAgentId: "writer",
        isDefault: true,
        label: "agent writer",
      },
    ]);
  });

  it("resolves the explicit default agent workspace", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {
        agents: {
          list: [
            { id: "writer", workspace: "/agents/writer" },
            { id: "ops", default: true, workspace: "/agents/ops" },
          ],
        },
      } as any,
      selector: { mode: "default-agent" },
    });

    expect(targets).toEqual([
      {
        workspaceDir: "/agents/ops",
        agentIds: ["ops"],
        primaryAgentId: "ops",
        isDefault: true,
        label: "agent ops",
      },
    ]);
  });

  it("dedupes shared workspaces for all-agent-workspaces", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/shared" },
            { id: "ops", workspace: "/agents/shared" },
            { id: "qa", workspace: "/agents/qa" },
          ],
        },
      } as any,
      selector: { mode: "all-agent-workspaces" },
    });

    expect(targets).toEqual([
      {
        workspaceDir: "/agents/shared",
        agentIds: ["main", "ops"],
        primaryAgentId: "main",
        isDefault: true,
        label: "agents main, ops",
      },
      {
        workspaceDir: "/agents/qa",
        agentIds: ["qa"],
        primaryAgentId: "qa",
        isDefault: false,
        label: "agent qa",
      },
    ]);
  });

  it("dedupes selected agents that share a workspace", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/shared" },
            { id: "ops", workspace: "/agents/shared" },
            { id: "qa", workspace: "/agents/qa" },
          ],
        },
      } as any,
      selector: { mode: "agents", agentIds: ["ops", "main", "ops", "qa"] },
    });

    expect(targets).toEqual([
      {
        workspaceDir: "/agents/shared",
        agentIds: ["ops", "main"],
        primaryAgentId: "ops",
        isDefault: true,
        label: "agents ops, main",
      },
      {
        workspaceDir: "/agents/qa",
        agentIds: ["qa"],
        primaryAgentId: "qa",
        isDefault: false,
        label: "agent qa",
      },
    ]);
  });

  it("resolves non-default generated workspace from agents.defaults.workspace", () => {
    const targets = resolveWorkspaceTargets({
      runtimeConfig: {
        agents: {
          defaults: {
            workspace: "/agents/root",
          },
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
      } as any,
      selector: { mode: "agent", agentId: "ops" },
    });

    expect(targets).toEqual([
      {
        workspaceDir: "/agents/root/ops",
        agentIds: ["ops"],
        primaryAgentId: "ops",
        isDefault: false,
        label: "agent ops",
      },
    ]);
  });

  it("rejects unknown explicit agents", () => {
    expect(() =>
      resolveWorkspaceTargets({
        runtimeConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/agents/main" }],
          },
        } as any,
        selector: { mode: "agent", agentId: "ghost" },
      }),
    ).toThrow(/Known agents: main/);
  });

  it("rejects an empty selected-agent list", () => {
    expect(() =>
      resolveWorkspaceTargets({
        runtimeConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: "/agents/main" }],
          },
        } as any,
        selector: { mode: "agents", agentIds: [] },
      }),
    ).toThrow(/At least one agent id is required/);
  });
});

describe("resolveAgentWorkspacePeerIds", () => {
  it("returns only agents that resolve to the same workspace", () => {
    const peers = resolveAgentWorkspacePeerIds({
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/shared" },
            { id: "ops", workspace: "/agents/shared" },
            { id: "qa", workspace: "/agents/qa" },
          ],
        },
      } as any,
      agentId: "main",
    });

    expect(peers).toEqual(["main", "ops"]);
  });

  it("keeps implicit main in its own workspace group", () => {
    expect(
      resolveAgentWorkspacePeerIds({
        runtimeConfig: {} as any,
        agentId: "main",
      }),
    ).toEqual(["main"]);
  });

  it("keeps generated per-agent workspaces separate", () => {
    const peers = resolveAgentWorkspacePeerIds({
      runtimeConfig: {
        agents: {
          defaults: { workspace: "/agents/shared" },
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
      } as any,
      agentId: "main",
    });

    expect(peers).toEqual(["main"]);
  });
});
