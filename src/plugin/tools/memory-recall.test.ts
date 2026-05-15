import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryRecallTool } from "./memory-recall.js";

const { resolveScopeMock, resolveLimitsMock, memoryRecallDbMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  resolveLimitsMock: vi.fn(() => ({ maxResults: 10 })),
  memoryRecallDbMock: vi.fn(),
}));

vi.mock("../../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("../../memory/limits.js", () => ({
  resolveMemoryLimits: resolveLimitsMock,
}));

vi.mock("../../memory/recall.js", () => ({
  memoryRecallDb: memoryRecallDbMock,
}));

function buildCtx() {
  const registerTool = vi.fn();
  return {
    ctx: {
      api: {
        registerTool,
        runtime: { agentId: "main", sessionKey: "agent:main:main" },
      },
      disabledReason: null,
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any,
    registerTool,
  };
}

describe("memory_recall tool exactTop1 metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits exactTop1 metadata and top exact line for literal top-1 match", async () => {
    (memoryRecallDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "memory",
      retrievalMode: "fts",
      results: [
        {
          corpus: "memory",
          path: "db-memory/items/1.md",
          id: "1",
          title: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
          kind: "note",
          score: 6.7,
          snippet: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
        },
      ],
      count: 1,
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryRecallTool({ ctx } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-1", {
      query: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
    });

    expect(result.content[0].text).toContain("Recalled 1 item(s).");
    expect(result.content[0].text).toContain("Top exact match: ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(result.details.meta).toMatchObject({
      exactTop1: true,
      exactTop1Value: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
    });
  });

  it("does not emit exactTop1 metadata for empty-query recent recall", async () => {
    (memoryRecallDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "memory",
      retrievalMode: "importance_recent",
      results: [
        {
          corpus: "memory",
          path: "db-memory/items/2.md",
          id: "2",
          title: "RETRIEVAL_MARKER_20260515_D gamma grape",
          kind: "note",
          score: 0,
          snippet: "RETRIEVAL_MARKER_20260515_D gamma grape",
        },
      ],
      count: 1,
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryRecallTool({ ctx } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-2", {});

    expect(result.content[0].text).toBe("Recalled 1 item(s).");
    expect(result.details.meta).toMatchObject({
      exactTop1: false,
      exactTop1Value: null,
    });
  });
});
