import { describe, expect, it, vi } from "vitest";

const { createPool } = vi.hoisted(() => ({
  createPool: vi.fn(),
}));

vi.mock("../postgres.js", () => ({
  createPostgresPool: createPool,
}));

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

describe("createPluginRuntimeContext.cleanupPool", () => {
  it("closes the created pool only once and clears runtime state", async () => {
    const end = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    createPool.mockReturnValueOnce({
      query,
      end,
    });
    const ctx = createPluginRuntimeContext({
      api: buildApi([]),
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
      } as any,
      disabledReason: undefined,
    });

    const pool = ctx.getPool();
    ctx.migrationsApplied = Promise.resolve();
    await ctx.cleanupPool();
    await ctx.cleanupPool();

    expect(pool.query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(ctx.pool).toBeUndefined();
    expect(ctx.migrationsApplied).toBeUndefined();
  });
});
