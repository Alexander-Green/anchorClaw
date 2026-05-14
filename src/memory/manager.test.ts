import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveScope,
  syncSessionsIndexDb,
  listKnownAgentIds,
  listSessionFilesForAgent,
  filterSessionHitsByVisibility,
  canAccessSessionPathByVisibility,
  memorySearchDb,
  memorySearchSessionsIndexDb,
  memoryGetFromDb,
} = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  syncSessionsIndexDb: vi.fn(async () => undefined),
  listKnownAgentIds: vi.fn(async () => []),
  listSessionFilesForAgent: vi.fn(async () => []),
  filterSessionHitsByVisibility: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
  canAccessSessionPathByVisibility: vi.fn(async () => ({ allowed: true })),
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
}));

vi.mock("./get.js", () => ({
  memoryGetFromDb,
}));

vi.mock("./sessions-visibility.js", () => ({
  filterSessionHitsByVisibility,
  canAccessSessionPathByVisibility,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  listSessionFilesForAgent,
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
    listSessionFilesForAgent.mockImplementation(async (agentId: string) =>
      agentId === "main" ? ["/state/agents/main/sessions/a.jsonl"] : ["/state/agents/other/sessions/b.jsonl"],
    );

    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
        sessions: { visibility: "visible" },
      } as any,
      ensureReady: async () => undefined,
      getPool: () => ({ query: vi.fn() }) as any,
      agentId: "main",
    });

    await manager.sync?.({ force: true });

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        agentId: "main",
        force: true,
        sessionFiles: ["/state/agents/main/sessions/a.jsonl", "/state/agents/other/sessions/b.jsonl"],
      }),
    );
  });
});

describe("createAnchorClawMemorySearchManager visibility behavior", () => {
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
    });
    const manager = createAnchorClawMemorySearchManager({
      api: {
        runtime: {
          sessionKey: "agent:main:main",
          workspaceDir: "/workspace",
        },
      } as any,
      cfg: {
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
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
});
