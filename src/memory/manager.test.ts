import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveScope,
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
  listKnownAgentIds,
  filterSessionHitsByVisibility,
  canAccessSessionPathByVisibility,
  memorySearchDb,
  memorySearchSessionsIndexDb,
  memoryGetFromDb,
} = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  syncSessionsIndexDb: vi.fn(async () => undefined),
  syncVisibleSessionsIndexDb: vi.fn(async () => undefined),
  listKnownAgentIds: vi.fn(async () => [] as string[]),
  filterSessionHitsByVisibility: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
  canAccessSessionPathByVisibility: vi.fn(async () => ({ allowed: true, reason: undefined as string | undefined })),
  memorySearchDb: vi.fn(async () => []),
  memorySearchSessionsIndexDb: vi.fn(async () => []),
  memoryGetFromDb: vi.fn(async () => ({ ok: false, error: "not found" })),
}));

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

vi.mock("./limits.js", () => ({
  resolveMemoryLimits: () => ({
    maxResults: 10,
    getDefaultLines: 120,
    getMaxChars: 12_000,
    sessionsMaxFileBytes: 2_000_000,
    sessionsWrapChars: 800,
  }),
}));

vi.mock("./search.js", () => ({
  memorySearchDb,
}));

vi.mock("./sessions.js", () => ({
  memorySearchSessions: vi.fn(async () => []),
  listKnownAgentIds,
}));

vi.mock("./sessions-index.js", () => ({
  hasSessionsIndexRows: vi.fn(async () => false),
  memorySearchSessionsIndexDb,
}));

vi.mock("./sessions-index-sync.js", () => ({
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
}));

vi.mock("./get.js", () => ({
  memoryGetFromDb,
}));

vi.mock("./sessions-visibility.js", () => ({
  filterSessionHitsByVisibility,
  canAccessSessionPathByVisibility,
}));

import { createAnchorClawMemorySearchManager } from "./manager.js";

beforeEach(() => {
  vi.clearAllMocks();
  resolveScope.mockResolvedValue({
    userId: "u1",
    workspaceId: "w1",
  });
});

describe("createAnchorClawMemorySearchManager.sync", () => {
  it("in visible visibility syncs sessions for all known agents when sessionFiles are not provided", async () => {
    listKnownAgentIds.mockResolvedValueOnce(["main", "other"]);

    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/workspace",
        sessions: { visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    await manager.sync?.({ force: true });

    expect(syncVisibleSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncVisibleSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        agentId: "main",
        force: true,
        otherAgentIds: ["other"],
      }),
    );
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });
});

describe("createAnchorClawMemorySearchManager visibility behavior", () => {
  it("filters sessions hits in current mode through visibility helper", async () => {
    vi.mocked(memorySearchDb).mockResolvedValueOnce([]);
    vi.mocked(memorySearchSessionsIndexDb).mockResolvedValueOnce([
      {
        corpus: "sessions",
        path: "sessions/main/a.jsonl",
        kind: "session",
        score: 0.7,
        snippet: "x",
        startLine: 1,
        endLine: 1,
      },
    ] as any);
    filterSessionHitsByVisibility.mockResolvedValueOnce([]);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/workspace",
        sessions: { visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const results = await manager.search("needle", { sources: ["sessions"] });
    expect(results).toHaveLength(0);
    expect(filterSessionHitsByVisibility).toHaveBeenCalledTimes(1);
  });

  it("filters sessions hits in visible mode through visibility helper", async () => {
    vi.mocked(memorySearchDb).mockResolvedValueOnce([]);
    vi.mocked(memorySearchSessionsIndexDb).mockResolvedValueOnce([
      {
        corpus: "sessions",
        path: "sessions/other/a.jsonl",
        kind: "session",
        score: 0.7,
        snippet: "x",
        startLine: 1,
        endLine: 1,
      },
    ] as any);
    filterSessionHitsByVisibility.mockResolvedValueOnce([]);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/workspace",
        sessions: { visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const results = await manager.search("needle", { sources: ["sessions"] });
    expect(results).toHaveLength(0);
    expect(filterSessionHitsByVisibility).toHaveBeenCalledTimes(1);
  });

  it("returns empty read result for sessions path when visibility helper denies access", async () => {
    canAccessSessionPathByVisibility.mockResolvedValueOnce({
      allowed: false,
      reason: "blocked",
    } as any);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/workspace",
        sessions: { visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const got = await manager.readFile({ relPath: "sessions/other/a.jsonl" });
    expect(got).toEqual({ text: "", path: "sessions/other/a.jsonl" });
    expect(memoryGetFromDb).not.toHaveBeenCalled();
  });

  it("returns empty read result for sessions path in current mode when visibility helper denies access", async () => {
    canAccessSessionPathByVisibility.mockResolvedValueOnce({
      allowed: false,
      reason: "blocked",
    } as any);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/workspace",
        sessions: { visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const got = await manager.readFile({ relPath: "sessions/main/a.jsonl" });
    expect(got).toEqual({ text: "", path: "sessions/main/a.jsonl" });
    expect(memoryGetFromDb).not.toHaveBeenCalled();
  });

  it("warns and exposes degraded status when workspaceDir is unavailable", async () => {
    const logger = { warn: vi.fn() };
    const manager = createAnchorClawMemorySearchManager({
      api: {
        logger,
        runtime: {
          sessionKey: "agent:main:main",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "   ",
        sessions: { visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    await expect(manager.search("needle", { sources: ["memory"] })).resolves.toEqual([]);
    await expect(manager.readFile({ relPath: "MEMORY.md" })).resolves.toEqual({ text: "", path: "MEMORY.md" });
    await manager.sync?.({});

    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager search skipped (workspace_dir_unavailable)");
    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager readFile skipped (workspace_dir_unavailable)");
    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager sync skipped (workspace unavailable)");
    expect(manager.status()).toMatchObject({
      custom: {
        degraded: true,
        error: "workspace_dir_unavailable",
      },
    });
  });
});
