import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveScope,
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
  filterSessionHitsByVisibility,
  canAccessSessionPathByVisibility,
  memorySearchDb,
  memorySearchSessionsIndexDb,
  memoryGetFromDb,
} = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  syncSessionsIndexDb: vi.fn(async () => undefined),
  syncVisibleSessionsIndexDb: vi.fn(async () => undefined),
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

function buildRuntime(
  workspaceDir = "/runtime/workspace",
  agents: Array<Record<string, unknown>> = [
    { id: "main", default: true, workspace: workspaceDir },
  ],
) {
  return {
    sessionKey: "agent:main:main",
    workspaceDir: "/legacy-workspace",
    config: {
      current: () => ({
        agents: {
          list: agents,
        },
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveScope.mockResolvedValue({
    userId: "u1",
    workspaceId: "w1",
  });
});

describe("createAnchorClawMemorySearchManager.sync", () => {
  it("in visible visibility syncs only agents that share the resolved workspace", async () => {
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: buildRuntime("/runtime/shared", [
          { id: "main", default: true, workspace: "/runtime/shared" },
          { id: "ops", workspace: "/runtime/shared" },
          { id: "qa", workspace: "/runtime/qa" },
        ]),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "visible" },
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
        otherAgentIds: ["ops"],
      }),
    );
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("does not fan visible sync out to agents from another workspace", async () => {
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: buildRuntime("/runtime/main", [
          { id: "main", default: true, workspace: "/runtime/main" },
          { id: "ops", workspace: "/runtime/ops" },
        ]),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        sessions: { search: { enabled: true }, visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    await manager.sync?.();

    expect(syncVisibleSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        otherAgentIds: [],
      }),
    );
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
        runtime: buildRuntime(),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "current" },
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
        runtime: buildRuntime(),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "visible" },
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
        sessions: { search: { enabled: true }, visibility: "visible" },
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
        runtime: buildRuntime(),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const got = await manager.readFile({ relPath: "sessions/main/a.jsonl" });
    expect(got).toEqual({ text: "", path: "sessions/main/a.jsonl" });
    expect(memoryGetFromDb).not.toHaveBeenCalled();
  });

  it("warns and exposes degraded status when runtime workspace is unavailable", async () => {
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
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    await expect(manager.search("needle", { sources: ["memory"] })).resolves.toEqual([]);
    await expect(manager.readFile({ relPath: "MEMORY.md" })).resolves.toEqual({ text: "", path: "MEMORY.md" });
    await manager.sync?.({});

    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager search skipped (runtime_workspace_unavailable)");
    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager readFile skipped (runtime_workspace_unavailable)");
    expect(logger.warn).toHaveBeenCalledWith("anchorclaw: manager sync skipped (runtime_workspace_unavailable)");
    expect(manager.status()).toMatchObject({
      custom: {
        degraded: true,
        error: "runtime_workspace_unavailable",
      },
    });
  });

  it("keeps sessions disabled by default unless sessions.search.enabled=true", async () => {
    vi.mocked(memorySearchDb).mockResolvedValueOnce([
      {
        corpus: "memory",
        path: "db-memory/items/m1.md",
        kind: "note",
        score: 0.9,
        snippet: "saved fact",
        startLine: 1,
        endLine: 1,
      },
    ] as any);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: buildRuntime(),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const results = await manager.search("saved");
    expect(memorySearchDb).toHaveBeenCalledTimes(1);
    expect(results.every((item) => item.source === "memory")).toBe(true);
    expect(memorySearchSessionsIndexDb).not.toHaveBeenCalled();
    expect(filterSessionHitsByVisibility).not.toHaveBeenCalled();
    expect(manager.status()).toMatchObject({
      sources: ["memory"],
      custom: {
        sessionsSearchConfigured: false,
        sessionsSearchEffective: false,
        sessionsSearchReason: "search_disabled",
        sessionsVisibility: "visible",
      },
    });
  });

  it("reads memory/* via DB-first compatibility path before falling back to workspace files", async () => {
    vi.mocked(memoryGetFromDb).mockResolvedValueOnce({
      ok: true,
      corpus: "memory",
      path: "memory/2026-05-20.md",
      kind: "daily-note",
      content: "db daily",
      fromLine: 1,
      lineCount: 3,
    } as any);
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: buildRuntime(),
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        workspaceDir: "/legacy-workspace",
        sessions: { search: { enabled: true }, visibility: "current" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    const got = await manager.readFile({ relPath: "memory/2026-05-20.md" });
    expect(got).toEqual({
      text: "db daily",
      path: "memory/2026-05-20.md",
      from: 1,
      lines: 3,
    });
    expect(memoryGetFromDb).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup: "memory/2026-05-20.md",
        workspaceDir: path.resolve("/runtime/workspace"),
      }),
    );
  });
});
