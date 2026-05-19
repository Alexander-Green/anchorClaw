import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemorySearchTool } from "./memory-search.js";

const {
  resolveScopeMock,
  resolveLimitsMock,
  memorySearchDbMock,
  memorySearchSessionsMock,
  hasSessionsIndexRowsMock,
  memorySearchSessionsIndexDbMock,
  filterSessionHitsByVisibilityMock,
} = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  resolveLimitsMock: vi.fn(() => ({ maxResults: 10 })),
  memorySearchDbMock: vi.fn(async () => []),
  memorySearchSessionsMock: vi.fn(async () => []),
  hasSessionsIndexRowsMock: vi.fn(async () => false),
  memorySearchSessionsIndexDbMock: vi.fn(async () => []),
  filterSessionHitsByVisibilityMock: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
}));

vi.mock("../../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("../../memory/limits.js", () => ({
  resolveMemoryLimits: resolveLimitsMock,
}));

vi.mock("../../memory/search.js", () => ({
  memorySearchDb: memorySearchDbMock,
}));

vi.mock("../../memory/sessions.js", () => ({
  memorySearchSessions: memorySearchSessionsMock,
}));

vi.mock("../../memory/sessions-index.js", () => ({
  hasSessionsIndexRows: hasSessionsIndexRowsMock,
  memorySearchSessionsIndexDb: memorySearchSessionsIndexDbMock,
}));

vi.mock("../../memory/sessions-visibility.js", () => ({
  filterSessionHitsByVisibility: filterSessionHitsByVisibilityMock,
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
      cfg: { workspaceDir: "/workspace", sessions: { visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
      sdkHealth: { degraded: false, reason: null, affectedOperation: null },
      markSdkSuccess: vi.fn(),
      markSdkError: vi.fn(),
    } as any,
    registerTool,
  };
}

describe("memory_search tool exactTop1 metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits exactTop1 metadata and top exact line for literal top-1 match", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/1.md",
        id: "1",
        title: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
        kind: "note",
        score: 6.7,
        snippet: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-1", {
      query: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      corpus: "memory",
    });
    const visible = JSON.parse(result.content[0].text);

    expect(visible.results).toHaveLength(1);
    expect(visible.queryMode).toBe("exact_value");
    expect(visible.topCandidates[0]).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(visible.results[0].snippet).toContain("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(visible.meta.recommendedAction).toBe("return_exact");
    expect(visible.meta.exactTop1Value).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(result.details.meta).toMatchObject({
      exactTop1: true,
      exactTop1Value: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      recommendedAction: "return_exact",
    });
  });

  it("does not emit exactTop1 metadata for non-literal top-1", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/2.md",
        id: "2",
        title: "RETRIEVAL_MARKER_20260515_D gamma grape",
        kind: "note",
        score: 1.4,
        snippet: "RETRIEVAL_MARKER_20260515_D gamma grape",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-2", { query: "smoke", corpus: "memory" });
    const visible = JSON.parse(result.content[0].text);

    expect(visible.results).toHaveLength(1);
    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.recommendedAction).toBe("inspect_top");
    expect(result.details.meta).toMatchObject({
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top",
    });
  });

  it("emits stop_not_found recommendation when there are no hits", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-3", { query: "nothing-here", corpus: "memory" });
    const visible = JSON.parse(result.content[0].text);

    expect(visible.results).toHaveLength(0);
    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.recommendedAction).toBe("stop_not_found");
    expect(result.details.meta).toMatchObject({
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "stop_not_found",
    });
  });

  it("boosts marker-like candidates in exact_value mode", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/desc.md",
        id: "desc",
        title: "anchorclaw post-restart smoke",
        kind: "note",
        score: 2.0,
        snippet: "anchorclaw post-restart smoke",
      },
      {
        corpus: "memory",
        path: "db-memory/items/marker.md",
        id: "marker",
        title: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
        kind: "note",
        score: 1.0,
        snippet: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-4", {
      query: "What exact marker did I save?",
      corpus: "memory",
    });
    const visible = JSON.parse(result.content[0].text);

    expect(visible.queryMode).toBe("exact_value");
    expect(visible.topCandidates[0]).toBe("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
    expect(visible.results[0].snippet).toContain("ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515");
  });

  it("keeps contextual mode for broad marker/id/key summary prompts", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/desc.md",
        id: "desc",
        title: "anchorclaw post-restart smoke",
        kind: "note",
        score: 2.0,
        snippet: "anchorclaw post-restart smoke",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-5", {
      query: "What marker/id/key values do we have around tests? Summarize briefly.",
      corpus: "memory",
    });
    const visible = JSON.parse(result.content[0].text);

    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.queryMode).toBe("contextual");
  });
});
