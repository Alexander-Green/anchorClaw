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
        runtime: {
          agentId: "main",
          sessionKey: "agent:main:main",
          config: {
            current: () => ({
              agents: {
                list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
              },
            }),
          },
        },
      },
      disabledReason: null,
      cfg: { workspaceDir: "/legacy-workspace" },
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
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(1);
    expect(visible.queryMode).toBe("exact_value");
    expect(visible.topCandidates[0]).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(visible.meta.recommendedAction).toBe("return_exact");
    expect(visible.meta.exactTop1Value).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(result.details.meta).toMatchObject({
      exactTop1: true,
      exactTop1Value: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      recommendedAction: "return_exact",
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
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(1);
    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.recommendedAction).toBe("inspect_top");
    expect(visible.meta.broadContext).toBe(true);
    expect(visible.meta.notExactEvidence).toBe(true);
    expect(String(visible.meta.note)).toContain("broad context");
    expect(result.details.meta).toMatchObject({
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top",
    });
  });

  it("emits stop_not_found recommendation when recall returns no hits", async () => {
    (memoryRecallDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "memory",
      retrievalMode: "fts",
      results: [],
      count: 0,
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryRecallTool({ ctx } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-3", { query: "nothing-here" });
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(0);
    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.recommendedAction).toBe("stop_not_found");
    expect(result.details.meta).toMatchObject({
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "stop_not_found",
    });
  });

  it("reranks marker-like value higher for exact_value recall query", async () => {
    (memoryRecallDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "memory",
      retrievalMode: "fts",
      results: [
        {
          corpus: "memory",
          path: "db-memory/items/desc.md",
          id: "2",
          title: "anchorclaw post-restart smoke",
          kind: "note",
          score: 2.0,
          snippet: "anchorclaw post-restart smoke",
        },
        {
          corpus: "memory",
          path: "db-memory/items/marker.md",
          id: "1",
          title: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
          kind: "note",
          score: 1.0,
          snippet: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
        },
      ],
      count: 2,
    });

    const { ctx, registerTool } = buildCtx();
    registerMemoryRecallTool({ ctx } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-4", {
      query: "What exact marker did I save?",
    });
    const visible = result.details.visible;

    expect(visible.queryMode).toBe("exact_value");
    expect(visible.topCandidates[0]).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(visible.results[0].snippet).toContain("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
  });
});
