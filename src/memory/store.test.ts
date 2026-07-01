import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSemanticEmbeddingMock } = vi.hoisted(() => ({
  buildSemanticEmbeddingMock: vi.fn(),
}));

vi.mock("../semantic/runtime.js", () => ({
  buildSemanticEmbedding: buildSemanticEmbeddingMock,
}));

import { memoryStoreDb } from "./store.js";

function buildPool() {
  const clientQueries: Array<{ text: string; values?: unknown[] }> = [];
  const poolQueries: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values });
      if (text.includes("SELECT id, type, namespace")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("INSERT INTO memory_items")) {
        return {
          rows: [{ id: "item-1", updated_at: "2026-06-16T10:00:00.000Z", version: 1 }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (text: string, values?: unknown[]) => {
      poolQueries.push({ text, values });
      return { rows: [], rowCount: 1 };
    }),
  } as any;
  return { pool, client, clientQueries, poolQueries };
}

describe("memoryStoreDb semantic write", () => {
  beforeEach(() => {
    buildSemanticEmbeddingMock.mockReset();
  });

  it("writes semantic sidecar after durable commit for direct store", async () => {
    buildSemanticEmbeddingMock.mockResolvedValueOnce({
      profileKey: "profile-123",
      providerKind: "generic",
      dimensions: 3,
      vector: [0.1, 0.2, 0.3],
    });
    const { pool, client, clientQueries, poolQueries } = buildPool();

    const result = await memoryStoreDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      actor: "tester",
      logger: { warn: vi.fn() },
      semantic: {
        cfg: { semantic: { enabled: true } },
        runtimeConfig: { agents: { list: [{ id: "main" }] } },
        agentId: "main",
      },
      input: {
        content: "Remember this durable fact.",
        type: "fact",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      id: "item-1",
      created: true,
    });
    expect(clientQueries.map((query) => query.text)).toContain("COMMIT");
    expect(buildSemanticEmbeddingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        text: "Remember this durable fact.",
        purpose: "document",
      }),
    );
    expect(poolQueries).toHaveLength(1);
    expect(poolQueries[0]?.text).toContain("INSERT INTO memory_item_embeddings");
    expect(poolQueries[0]?.values).toEqual(["item-1", "profile-123", "[0.1,0.2,0.3]", 1, 3]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("keeps durable write successful when semantic embedding build fails", async () => {
    buildSemanticEmbeddingMock.mockRejectedValueOnce(new Error("provider offline"));
    const { pool, client, poolQueries } = buildPool();
    const logger = { warn: vi.fn() };

    const result = await memoryStoreDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      actor: "tester",
      logger,
      semantic: {
        cfg: { semantic: { enabled: true } },
        runtimeConfig: { agents: { list: [{ id: "main" }] } },
        agentId: "main",
      },
      input: {
        content: "Keep the durable write even if semantic is down.",
      },
    });

    expect(result).toMatchObject({
      ok: true,
      id: "item-1",
    });
    expect(poolQueries).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "anchorclaw: semantic write skipped for memory item item-1 (provider offline)",
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
