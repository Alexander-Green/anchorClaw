import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemorySearchTool } from "./memory-search.js";

const {
  resolveScopeMock,
  resolveLimitsMock,
  memorySearchDbMock,
  memorySearchDailyDbMock,
  memorySearchSemanticDbMock,
  memorySearchSessionsMock,
  hasSessionsIndexRowsMock,
  memorySearchSessionsIndexDbMock,
  filterSessionHitsByVisibilityMock,
  scanLegacyWorkspaceMock,
  countMissingSemanticEmbeddingsMock,
  enqueueSemanticIndexingRequestMock,
  indexMissingSemanticEmbeddingsMock,
  buildSemanticEmbeddingMock,
  resolveSemanticRuntimeProfileMock,
} = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  resolveLimitsMock: vi.fn(() => ({ maxResults: 10 })),
  memorySearchDbMock: vi.fn(async () => []),
  memorySearchDailyDbMock: vi.fn(async () => []),
  memorySearchSemanticDbMock: vi.fn(async () => []),
  memorySearchSessionsMock: vi.fn(async () => []),
  hasSessionsIndexRowsMock: vi.fn(async () => false),
  memorySearchSessionsIndexDbMock: vi.fn(async () => []),
  filterSessionHitsByVisibilityMock: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
  scanLegacyWorkspaceMock: vi.fn(async () => ({
    sourceDir: "/workspace",
    targetWorkspaceDir: "/workspace",
    memoryMd: { path: "MEMORY.md", state: "absent", sha256: null, importedSameSha: false },
    dailyFiles: [],
    activeLegacyCount: 0,
    pendingCount: 0,
    unsupportedCount: 0,
    unreadableCount: 0,
    hasActiveLegacy: false,
  })),
  countMissingSemanticEmbeddingsMock: vi.fn(async () => 0),
  enqueueSemanticIndexingRequestMock: vi.fn(async () => ({ queued: true })),
  indexMissingSemanticEmbeddingsMock: vi.fn(async () => ({
    enabled: true,
    profileKey: "profile-1",
    attempted: 0,
    indexed: 0,
    remaining: 0,
  })),
  buildSemanticEmbeddingMock: vi.fn(async () => ({
    profileKey: "profile-1",
    providerKind: "generic",
    dimensions: 3,
    vector: [0.1, 0.2, 0.3],
  })),
  resolveSemanticRuntimeProfileMock: vi.fn(() => ({
    resolvedMemorySearch: null,
    profile: {
      configured: false,
      enabled: false,
      effective: false,
      reasonCode: "semantic_disabled",
    },
  })),
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
  memorySearchSemanticDb: memorySearchSemanticDbMock,
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

vi.mock("../../importer.js", () => ({
  scanLegacyWorkspace: scanLegacyWorkspaceMock,
}));

vi.mock("../../semantic/indexing.js", () => ({
  countMissingSemanticEmbeddings: countMissingSemanticEmbeddingsMock,
  enqueueSemanticIndexingRequest: enqueueSemanticIndexingRequestMock,
  indexMissingSemanticEmbeddings: indexMissingSemanticEmbeddingsMock,
}));

vi.mock("../../semantic/runtime.js", () => ({
  buildSemanticEmbedding: buildSemanticEmbeddingMock,
  resolveSemanticRuntimeProfile: resolveSemanticRuntimeProfileMock,
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
      cfg: { sessions: { search: { enabled: true }, visibility: "current" } },
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

function buildToolContext(overrides?: Record<string, unknown>) {
  return {
    runtimeConfig: {
      agents: {
        list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
      },
    },
    workspaceDir: "/runtime/workspace",
    agentId: "main",
    sessionKey: "agent:main:main",
    ...overrides,
  };
}

function materializeRegisteredTool(registerTool: ReturnType<typeof vi.fn>, overrides?: Record<string, unknown>) {
  const factory = registerTool.mock.calls[0]?.[0];
  const opts = registerTool.mock.calls[0]?.[1];
  expect(opts).toEqual({ name: "memory_search" });
  expect(factory).toBeTypeOf("function");
  return factory(buildToolContext(overrides));
}

describe("memory_search tool exactTop1 metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (resolveSemanticRuntimeProfileMock as any).mockReturnValue({
      resolvedMemorySearch: null,
      profile: {
        configured: false,
        enabled: false,
        effective: false,
        reasonCode: "semantic_disabled",
      },
    });
    buildSemanticEmbeddingMock.mockResolvedValue({
      profileKey: "profile-1",
      providerKind: "generic",
      dimensions: 3,
      vector: [0.1, 0.2, 0.3],
    });
    countMissingSemanticEmbeddingsMock.mockResolvedValue(0);
    enqueueSemanticIndexingRequestMock.mockResolvedValue({ queued: true });
    indexMissingSemanticEmbeddingsMock.mockResolvedValue({
      enabled: true,
      profileKey: "profile-1",
      attempted: 0,
      indexed: 0,
      remaining: 0,
    });
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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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

  it("uses tool context workspace and agent instead of global runtime agent", async () => {
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool, {
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/runtime/workspace" },
            { id: "ops", workspace: "/runtime/ops" },
          ],
        },
      },
      workspaceDir: "/runtime/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });

    await def.execute("toolcall-toolctx-1", { query: "ops", corpus: "memory" });

    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("runs inline semantic indexing before queuing maintenance when semantic backlog exists", async () => {
    (resolveSemanticRuntimeProfileMock as any).mockReturnValue({
      resolvedMemorySearch: {},
      profile: {
        configured: true,
        enabled: true,
        effective: true,
        profileKey: "profile-1",
        provider: "openai-compatible",
        model: "text-embedding-3-small",
      },
    });
    memorySearchDbMock.mockResolvedValueOnce([]);
    (memorySearchSemanticDbMock as any)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          corpus: "memory",
          path: "db-memory/items/semantic-1.md",
          id: "semantic-1",
          title: "Semantic hit",
          kind: "fact",
          score: 0.91,
          snippet: "Semantic hit from embedding search",
        },
      ]);
    countMissingSemanticEmbeddingsMock.mockResolvedValueOnce(3);
    indexMissingSemanticEmbeddingsMock.mockResolvedValueOnce({
      enabled: true,
      profileKey: "profile-1",
      attempted: 1,
      indexed: 1,
      remaining: 2,
    });
    const { ctx, registerTool } = buildCtx();
    ctx.cfg = { semantic: { enabled: true }, sessions: { search: { enabled: true }, visibility: "current" } };
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-semantic-1", {
      query: "meaningful context",
      corpus: "memory",
    });

    expect(buildSemanticEmbeddingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "query",
        text: "meaningful context",
      }),
    );
    expect(indexMissingSemanticEmbeddingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        userId: "u1",
        workspaceId: "w1",
        limit: 5,
        expectedDimensions: 3,
      }),
    );
    expect(memorySearchSemanticDbMock).toHaveBeenCalledTimes(2);
    expect(enqueueSemanticIndexingRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        agentId: "main",
        profileKey: "profile-1",
        reason: "search_missing",
      }),
    );
    expect(result.details.meta.retrievalMode).toBe("hybrid_memory");
    expect(result.details.meta.semantic).toMatchObject({
      enabled: true,
      profileKey: "profile-1",
      queryEmbedded: true,
      inlineAttempted: 1,
      inlineIndexed: 1,
      backlog: 2,
      queued: true,
    });
    expect(result.details.results[0]).toMatchObject({
      id: "semantic-1",
      snippet: "Semantic hit from embedding search",
    });
  });

  it("uses durable importance to break equal hybrid RRF scores", async () => {
    (resolveSemanticRuntimeProfileMock as any).mockReturnValue({
      resolvedMemorySearch: {},
      profile: {
        configured: true,
        enabled: true,
        effective: true,
        profileKey: "profile-1",
        provider: "openai-compatible",
        model: "text-embedding-3-small",
      },
    });
    const high = {
      corpus: "memory",
      path: "db-memory/items/z-high.md",
      id: "z-high",
      kind: "fact",
      importance: 90,
      score: 0.8,
      snippet: "high importance",
    };
    const low = {
      corpus: "memory",
      path: "db-memory/items/a-low.md",
      id: "a-low",
      kind: "fact",
      importance: 10,
      score: 0.8,
      snippet: "low importance",
    };
    (memorySearchDbMock as any).mockResolvedValueOnce([high, low]);
    (memorySearchSemanticDbMock as any).mockResolvedValueOnce([low, high]);
    const { ctx, registerTool } = buildCtx();
    ctx.cfg = { semantic: { enabled: true }, sessions: { search: { enabled: true }, visibility: "current" } };
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-hybrid-importance", {
      query: "equal hybrid rank",
      corpus: "memory",
    });

    expect(result.details.results.map((hit: { id: string }) => hit.id)).toEqual(["z-high", "a-low"]);
  });

  it("keeps durable memory ahead of daily memory on equal hybrid RRF score", async () => {
    (resolveSemanticRuntimeProfileMock as any).mockReturnValue({
      resolvedMemorySearch: {},
      profile: {
        configured: true,
        enabled: true,
        effective: true,
        profileKey: "profile-1",
        provider: "openai-compatible",
        model: "text-embedding-3-small",
      },
    });
    (memorySearchDbMock as any).mockResolvedValueOnce([
      {
        corpus: "daily",
        path: "memory/2026-07-15.md",
        id: "daily-1",
        kind: "daily-note",
        score: 0.9,
        snippet: "daily result",
      },
    ]);
    (memorySearchSemanticDbMock as any).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/durable-1.md",
        id: "durable-1",
        kind: "fact",
        importance: 1,
        score: 0.9,
        snippet: "durable result",
      },
    ]);
    const { ctx, registerTool } = buildCtx();
    ctx.cfg = { semantic: { enabled: true }, sessions: { search: { enabled: true }, visibility: "current" } };
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-hybrid-durable", {
      query: "equal cross-corpus rank",
      corpus: "memory",
    });

    expect(result.details.results.map((hit: { id: string }) => hit.id)).toEqual(["durable-1", "daily-1"]);
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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
    expect(result.details.meta.legacyImportWarning).toBeUndefined();
  });

  it("adds a legacy import warning on empty memory results when active legacy files still exist", async () => {
    (memorySearchDbMock as any).mockResolvedValueOnce([]);
    scanLegacyWorkspaceMock.mockResolvedValueOnce({
      sourceDir: "/workspace",
      targetWorkspaceDir: "/workspace",
      memoryMd: { path: "MEMORY.md", state: "pending", sha256: "sha-memory", importedSameSha: false },
      dailyFiles: [],
      activeLegacyCount: 1,
      pendingCount: 1,
      unsupportedCount: 0,
      unreadableCount: 0,
      hasActiveLegacy: true,
    } as any);
    const { ctx, registerTool } = buildCtx();
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-3b", { query: "favorite pizza", corpus: "memory" });

    expect(result.content[0].text).toContain("Legacy memory import is still pending");
    expect(result.details.meta.legacyImportWarning).toContain("missing DB results do not prove");
    expect(scanLegacyWorkspaceMock).toHaveBeenCalledTimes(1);
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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped,
    });
    const def = materializeRegisteredTool(registerTool);

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

  it("redirects sessions corpus to native OpenClaw search on modern hosts", async () => {
    const { ctx, registerTool } = buildCtx();
    ctx.api.runtime.version = "2026.8.1-beta.1";
    ctx.durableState = {
      overall: "blocked",
      migrations: "failed",
      reason: "migrations_failed: database unavailable",
    };
    ctx.startupCriticalFailure = "migrations_failed: database unavailable";
    ctx.ensureReady.mockRejectedValue(new Error("database unavailable"));
    const ensureSessionsIndexBootstrapped = vi.fn(async () => undefined);
    const ensureStartupBootstrap = vi.fn(async () => {
      throw new Error("bootstrap must not run");
    });
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped,
      ensureStartupBootstrap,
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-native-sessions", {
      query: "needle",
      corpus: "sessions",
    });

    expect(def.description).toContain("use sessions_search and sessions_history");
    expect(result.content[0].text).toContain("Retry this query with sessions_search");
    expect(result.content[0].text).not.toContain("No results found");
    expect(result.details.meta.sessions).toMatchObject({
      configured: true,
      effective: false,
      mode: "native-openclaw",
      reason: "native_openclaw",
      replacementTool: "sessions_search",
    });
    expect(ensureStartupBootstrap).not.toHaveBeenCalled();
    expect(ctx.ensureReady).not.toHaveBeenCalled();
    expect(ctx.getPool).not.toHaveBeenCalled();
    expect(resolveScopeMock).not.toHaveBeenCalled();
    expect(ensureSessionsIndexBootstrapped).not.toHaveBeenCalled();
    expect(memorySearchSessionsIndexDbMock).not.toHaveBeenCalled();
    expect(memorySearchSessionsMock).not.toHaveBeenCalled();
  });

  it("makes native session exclusion explicit for corpus=all", async () => {
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
    ctx.api.runtime.version = "2026.8.1-beta.1";
    registerMemorySearchTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-native-all", { query: "saved", corpus: "all" });

    expect(result.content[0].text).toContain("corpus=all covers AnchorClaw memory only");
    expect(result.content[0].text).toContain("Use sessions_search separately");
    expect(result.details.meta.sessions).toMatchObject({
      mode: "native-openclaw",
      reason: "native_openclaw",
      replacementTool: "sessions_search",
    });
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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped,
    });
    const def = materializeRegisteredTool(registerTool);

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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
      invalidatePromptMemory: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });
    const def = materializeRegisteredTool(registerTool);

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
