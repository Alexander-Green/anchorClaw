import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildSemanticEmbeddingMock,
  resolveSemanticRuntimeProfileMock,
} = vi.hoisted(() => ({
  buildSemanticEmbeddingMock: vi.fn(),
  resolveSemanticRuntimeProfileMock: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  buildSemanticEmbedding: buildSemanticEmbeddingMock,
  resolveSemanticRuntimeProfile: resolveSemanticRuntimeProfileMock,
}));

import {
  enqueueSemanticIndexingRequest,
  indexMissingSemanticEmbeddings,
  processSemanticIndexingRequests,
  upsertMemoryItemEmbedding,
} from "./indexing.js";

function semanticProfile(profileKey = "profile-1") {
  return {
    resolvedMemorySearch: {},
    profile: {
      configured: true,
      enabled: true,
      effective: true,
      profileKey,
      provider: "openai-compatible",
      model: "text-embedding-3-small",
    },
  };
}

describe("semantic indexing helpers", () => {
  beforeEach(() => {
    buildSemanticEmbeddingMock.mockReset();
    resolveSemanticRuntimeProfileMock.mockReset();
    resolveSemanticRuntimeProfileMock.mockReturnValue(semanticProfile());
  });

  it("upserts embeddings with item version and dimensions", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    await upsertMemoryItemEmbedding({
      pool,
      memoryItemId: "item-1",
      profileKey: "profile-1",
      vector: [0.1, 0.2, 0.3],
      memoryItemVersion: 7,
      dimensions: 3,
    });

    expect(calls[0]?.sql).toContain("memory_item_version");
    expect(calls[0]?.sql).toContain("dimensions");
    expect(calls[0]?.values).toEqual(["item-1", "profile-1", "[0.1,0.2,0.3]", 7, 3]);
  });

  it("indexes a bounded batch of missing semantic embeddings", async () => {
    buildSemanticEmbeddingMock.mockResolvedValueOnce({
      profileKey: "profile-1",
      providerKind: "generic",
      dimensions: 3,
      vector: [0.1, 0.2, 0.3],
    });
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("SELECT mi.id, mi.content, mi.version")) {
          return {
            rows: [{ id: "item-1", content: "Document to index", version: 2 }],
            rowCount: 1,
          };
        }
        if (sql.includes("SELECT count(*) AS count")) {
          return { rows: [{ count: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    const result = await indexMissingSemanticEmbeddings({
      pool,
      cfg: { semantic: { enabled: true } },
      runtimeConfig: { agents: { list: [{ id: "main" }] } },
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      limit: 5,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      enabled: true,
      profileKey: "profile-1",
      attempted: 1,
      indexed: 1,
      remaining: 0,
    });
    expect(buildSemanticEmbeddingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        purpose: "document",
        text: "Document to index",
      }),
    );
    expect(calls.some((call) => call.sql.includes("LEFT JOIN memory_item_embeddings"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT INTO memory_item_embeddings"))).toBe(true);
  });

  it("queues semantic indexing requests idempotently", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    const result = await enqueueSemanticIndexingRequest({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      profileKey: "profile-1",
      reason: "search_missing",
    });

    expect(result).toEqual({ queued: true });
    expect(calls[0]?.sql).toContain("ON CONFLICT (user_id, workspace_id, profile_key)");
    expect(calls[0]?.values).toEqual(["u1", "w1", "profile-1", "main", "search_missing"]);
  });

  it("processes pending semantic requests and deletes completed ones", async () => {
    buildSemanticEmbeddingMock.mockResolvedValueOnce({
      profileKey: "profile-1",
      providerKind: "generic",
      dimensions: 3,
      vector: [0.1, 0.2, 0.3],
    });
    const calls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (sql.includes("FROM semantic_indexing_requests")) {
          return {
            rows: [
              {
                user_id: "u1",
                workspace_id: "w1",
                profile_key: "profile-1",
                agent_id: "main",
                attempts: 0,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("SELECT mi.id, mi.content, mi.version")) {
          return {
            rows: [{ id: "item-1", content: "Queued document", version: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes("SELECT count(*) AS count")) {
          return { rows: [{ count: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    } as any;

    const result = await processSemanticIndexingRequests({
      pool,
      cfg: { semantic: { enabled: true } },
      runtimeConfig: { agents: { list: [{ id: "main" }] } },
      userId: "u1",
      workspaceId: "w1",
      requestLimit: 5,
      itemBatchSize: 5,
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      processedRequests: 1,
      indexed: 1,
      requeued: 0,
      failed: 0,
    });
    expect(calls.some((call) => call.sql.includes("DELETE FROM semantic_indexing_requests"))).toBe(true);
  });
});
