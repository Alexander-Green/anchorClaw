import { describe, expect, it, vi } from "vitest";

const { createPool, applyMigrations, loadBaseMigrations, loadSemanticMigrations } = vi.hoisted(() => ({
  createPool: vi.fn(),
  applyMigrations: vi.fn(async () => ({ applied: [] as string[] })),
  loadBaseMigrations: vi.fn(async () => [{ filename: "0001_init.sql", sql: "SELECT 1" }]),
  loadSemanticMigrations: vi.fn(async () => [{ filename: "0001_memory_item_embeddings.sql", sql: "SELECT 1" }]),
}));

vi.mock("../postgres.js", () => ({
  createPostgresPool: createPool,
}));

vi.mock("../migrations.js", () => ({
  applyMigrations,
}));

vi.mock("../migrations-fs.js", () => ({
  loadBundledMigrationsFromDisk: loadBaseMigrations,
  loadBundledSemanticMigrationsFromDisk: loadSemanticMigrations,
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

describe("createPluginRuntimeContext.ensureReady", () => {
  it("applies semantic migrations through the configured app-user pool", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    createPool.mockReturnValueOnce(pool);
    applyMigrations.mockResolvedValueOnce({ applied: ["0001"] }).mockResolvedValueOnce({ applied: ["0001", "0002"] });

    const ctx = createPluginRuntimeContext({
      api: buildApi([]),
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
        semantic: { enabled: true },
      } as any,
      disabledReason: undefined,
    });

    await ctx.ensureReady();

    expect(applyMigrations).toHaveBeenNthCalledWith(1, {
      pool,
      migrations: [{ filename: "0001_init.sql", sql: "SELECT 1" }],
    });
    expect(applyMigrations).toHaveBeenNthCalledWith(2, {
      pool,
      migrations: [{ filename: "0001_memory_item_embeddings.sql", sql: "SELECT 1" }],
      tableName: "semantic_schema_migrations",
    });
  });

  it("keeps base memory available when semantic schema preparation fails", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      end: vi.fn(async () => undefined),
    };
    const api = buildApi([]);
    createPool.mockReturnValueOnce(pool);
    applyMigrations.mockResolvedValueOnce({ applied: [] }).mockRejectedValueOnce(new Error("extension vector is unavailable"));

    const ctx = createPluginRuntimeContext({
      api,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
        semantic: { enabled: true },
      } as any,
      disabledReason: undefined,
    });

    await expect(ctx.ensureReady()).resolves.toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: semantic schema is unavailable; continuing with lexical memory (extension vector is unavailable)",
    );
  });
});
