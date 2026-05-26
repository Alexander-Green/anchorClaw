import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemorySearchTool } from "./memory-search.js";

const {
  resolveScopeMock,
  resolveLimitsMock,
  memorySearchDbMock,
  memorySearchDailyDbMock,
  memorySearchSessionsMock,
  hasSessionsIndexRowsMock,
  memorySearchSessionsIndexDbMock,
  filterSessionHitsByVisibilityMock,
} = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  resolveLimitsMock: vi.fn(() => ({ maxResults: 10 })),
  memorySearchDbMock: vi.fn(async () => []),
  memorySearchDailyDbMock: vi.fn(async () => []),
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
  memorySearchDailyDb: memorySearchDailyDbMock,
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
      cfg: { workspaceDir: "/workspace", sessions: { search: { enabled: true }, visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
      durableState: { overall: "ready", migrations: "ready", reason: null },
      sdkHealth: { degraded: false, reason: null, affectedOperation: null },
      markSdkSuccess: vi.fn(),
      markSdkError: vi.fn(),
      setDurableState: vi.fn(),
      setStartupCriticalFailure: vi.fn(),
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
    const visible = result.details.visible;

    expect(result.content[0].text).toContain("Found 1 result");
    expect(() => JSON.parse(result.content[0].text)).toThrow();
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
    const visible = result.details.visible;

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
    const visible = result.details.visible;

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
    const visible = result.details.visible;

    expect(visible.queryMode).toBe("contextual");
    expect(visible.meta.queryMode).toBe("contextual");
  });

  it("treats sessions corpus as unavailable by default until opt-in is enabled", async () => {
    const { ctx, registerTool } = buildCtx();
    ctx.cfg.sessions = { visibility: "current" };
    const ensureSessionsIndexBootstrapped = vi.fn(async () => undefined);
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped,
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-6", { query: "needle", corpus: "sessions" });
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(0);
    expect(visible.meta.recommendedAction).toBe("stop_not_found");
    expect(result.details.meta.sessions).toMatchObject({
      configured: false,
      effective: false,
      visibility: "current",
      reason: "search_disabled",
    });
    expect(ensureSessionsIndexBootstrapped).not.toHaveBeenCalled();
    expect(memorySearchSessionsIndexDbMock).not.toHaveBeenCalled();
    expect(memorySearchSessionsMock).not.toHaveBeenCalled();
  });

  it("excludes sessions from corpus=all when opt-in is disabled", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/1.md",
        id: "1",
        title: "saved fact",
        kind: "note",
        score: 1.2,
        snippet: "saved fact",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    ctx.cfg.sessions = { visibility: "visible" };
    const ensureSessionsIndexBootstrapped = vi.fn(async () => undefined);
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped,
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-7", { query: "saved", corpus: "all" });
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(1);
    expect(visible.results[0].corpus).toBe("memory");
    expect(result.details.meta.sessions).toMatchObject({
      configured: false,
      effective: false,
      visibility: "visible",
      reason: "search_disabled",
    });
    expect(ensureSessionsIndexBootstrapped).not.toHaveBeenCalled();
    expect(memorySearchSessionsIndexDbMock).not.toHaveBeenCalled();
    expect(memorySearchSessionsMock).not.toHaveBeenCalled();
  });

  it("routes corpus=daily to daily-only DB search", async () => {
    (memorySearchDailyDbMock as any).mockResolvedValueOnce([
      {
        corpus: "daily",
        path: "memory/2026-05-20.md",
        id: "daily-1",
        title: "memory/2026-05-20.md",
        kind: "daily-note",
        score: 1.1,
        snippet: "today we discussed daily ownership",
      },
    ] as any[]);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-8", { query: "daily ownership", corpus: "daily" });
    const visible = result.details.visible;

    expect(visible.results).toHaveLength(1);
    expect(visible.results[0].path).toBe("memory/2026-05-20.md");
    expect(visible.results[0].corpus).toBe("daily");
    expect(visible.results[0].source).toBe("daily");
    expect(result.content[0].text).toContain("[daily DB entry] memory/2026-05-20.md#L1");
    expect(result.content[0].text).toContain("Source: DB daily entry memory/2026-05-20.md#L1");
    expect(result.details.meta.retrievalMode).toBe("fts_daily");
    expect(memorySearchDailyDbMock).toHaveBeenCalledTimes(1);
    expect(memorySearchDbMock).not.toHaveBeenCalled();
  });

  it("returns degraded response when ensureReady fails on migrations", async () => {
    const { ctx, registerTool } = buildCtx();
    ctx.ensureReady = vi.fn(async () => {
      throw new Error("migrations_failed: generation expression is not immutable");
    });
    registerMemorySearchTool({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-schema-1", {
      query: "favorite color",
      corpus: "memory",
    });

    expect(result.content[0].text).toContain("memory_search degraded");
    expect(result.details).toMatchObject({
      degraded: true,
      degradedReason: "migrations_failed",
      error: "migrations_failed: generation expression is not immutable",
    });
    expect(memorySearchDbMock).not.toHaveBeenCalled();
    expect(ctx.setDurableState).toHaveBeenCalledWith(
      expect.objectContaining({
        overall: "blocked",
        migrations: "failed",
        reason: "migrations_failed: generation expression is not immutable",
      }),
    );
    expect(ctx.setStartupCriticalFailure).toHaveBeenCalledWith(
      "migrations_failed: generation expression is not immutable",
    );
  });
});
