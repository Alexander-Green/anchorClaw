import { describe, expect, it, vi } from "vitest";

import { createPluginRuntimeContext } from "./runtime-context.js";

function buildApi(agents: Array<Record<string, unknown>>) {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      agentId: "main",
      config: {
        current: () => ({
          agents: { list: agents },
        }),
      },
    },
  } as any;
}

describe("createPluginRuntimeContext.listVisibleAgentIds", () => {
  it("returns only agents that share the current resolved workspace", async () => {
    const ctx = createPluginRuntimeContext({
      api: buildApi([
        { id: "main", default: true, workspace: "/agents/shared" },
        { id: "ops", workspace: "/agents/shared" },
        { id: "qa", workspace: "/agents/qa" },
      ]),
      cfg: undefined,
      disabledReason: undefined,
    });

    await expect(ctx.listVisibleAgentIds()).resolves.toEqual(["main", "ops"]);
  });

  it("fails closed to the current agent when runtime config is unavailable", async () => {
    const ctx = createPluginRuntimeContext({
      api: {
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
        },
        runtime: {
          agentId: "main",
        },
      } as any,
      cfg: undefined,
      disabledReason: undefined,
    });

    await expect(ctx.listVisibleAgentIds()).resolves.toEqual(["main"]);
  });
});
