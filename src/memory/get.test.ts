import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryGetFromDb } from "./get.js";

vi.mock("./sessions.js", () => ({
  memoryGetSessionFile: vi.fn(),
}));

vi.mock("./sessions-index-sync.js", () => ({
  syncSessionsIndexDb: vi.fn(async () => undefined),
}));

import { memoryGetSessionFile } from "./sessions.js";
import { syncSessionsIndexDb } from "./sessions-index-sync.js";

const limits = {
  maxResults: 10,
  getMaxChars: 12_000,
  getDefaultLines: 120,
  sessionsMaxFileBytes: 2_000_000,
  sessionsWrapChars: 800,
} as const;

function createPool(rowsByCall: Array<unknown[]>) {
  const query = vi.fn(async () => ({ rows: rowsByCall.shift() ?? [] }));
  return { query } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memoryGetFromDb sessions visibility", () => {
  it("rejects other-agent sessions lookup in current visibility", async () => {
    const pool = createPool([]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/other/s1.jsonl",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toContain("restricted to current agent scope");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects other-agent sessions lookup in current visibility when runtime agentId is missing", async () => {
    const pool = createPool([]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/other/s1.jsonl",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toContain("restricted to current agent scope");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("allows other-agent lookup in visible visibility and can fallback to file", async () => {
    const pool = createPool([[], []]);
    vi.mocked(memoryGetSessionFile).mockResolvedValueOnce({
      text: "User: hi",
      path: "sessions/other/s1.jsonl",
      from: 1,
      lines: 1,
    });
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionsVisibility: "visible",
      limits,
      lookup: "sessions/other/s1.jsonl",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.path).toBe("sessions/other/s1.jsonl");
    expect(got.content).toContain("User: hi");
  });

  it("reads indexed sessions content for current agent", async () => {
    const pool = createPool([
      [{ id: "f1" }],
      [
        { text: "User: hello", start_line: 3 },
        { text: "Assistant: hi", start_line: 7 },
      ],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/main/s1.jsonl",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.path).toBe("sessions/main/s1.jsonl");
    expect(got.content).toContain("User: hello");
    expect(got.content).toContain("Assistant: hi");
  });

  it("applies upstream agent normalization for current-visibility sessions scope", async () => {
    const pool = createPool([
      [{ id: "f1" }],
      [{ text: "User: hello", start_line: 2 }],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "Team.Alpha",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/team-alpha/s1.jsonl",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.path).toBe("sessions/team-alpha/s1.jsonl");
    expect(got.content).toContain("User: hello");
  });

  it("returns index_corrupt error when file row exists but indexed read is missing", async () => {
    const pool = createPool([[], [{ id: "indexed-row" }]]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/main/s1.jsonl",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toContain("index corrupted");
    expect(vi.mocked(memoryGetSessionFile)).not.toHaveBeenCalled();
  });

  it("on index_miss uses file fallback and enqueues targeted reindex", async () => {
    const pool = createPool([[], []]);
    vi.mocked(memoryGetSessionFile).mockResolvedValueOnce({
      text: "User: fallback",
      path: "sessions/main/s1.jsonl",
      from: 1,
      lines: 1,
    });
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionsVisibility: "current",
      limits,
      lookup: "sessions/main/s1.jsonl",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.content).toContain("fallback");
    expect(vi.mocked(syncSessionsIndexDb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncSessionsIndexDb)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        agentId: "main",
        sessionFiles: ["sessions/main/s1.jsonl"],
      }),
    );
  });
});

describe("memoryGetFromDb DB-owned daily memory", () => {
  it("reads imported DB daily content through memory/* compatibility paths", async () => {
    const pool = createPool([
      [
        {
          id: "11111111-1111-1111-1111-111111111111",
          path: "memory/2026-05-20.md",
          logical_date: "2026-05-20",
          content: "DB daily content",
          content_sha256: "sha",
          source_kind: "legacy_import",
          source_path: "/workspace/memory/2026-05-20.md",
          metadata: {},
          created_at: "2026-05-20T10:00:00.000Z",
          updated_at: "2026-05-20T10:00:00.000Z",
        },
      ],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits,
      lookup: "memory/2026-05-20.md",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.path).toBe("memory/2026-05-20.md");
    expect(got.kind).toBe("daily-note");
    expect(got.content).toContain("DB daily content");
  });

  it("hides internal-only session-capture rows from memory/* lookups", async () => {
    const pool = createPool([
      [
        {
          id: "22222222-2222-2222-2222-222222222222",
          path: "memory/2026-06-03-0915-a1b2c3d4-session-capture.md",
          logical_date: "2026-06-03",
          content: "user: remember the reset capture canary",
          content_sha256: "sha",
          source_kind: "session_memory",
          source_path: null,
          metadata: {},
          created_at: "2026-06-03T09:15:00.000Z",
          updated_at: "2026-06-03T09:15:00.000Z",
        },
      ],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits,
      lookup: "memory/2026-06-03-0915-a1b2c3d4-session-capture.md",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toBe("not found");
  });

  it("reads db-memory/daily/<uuid>.md directly from canonical daily table", async () => {
    const pool = createPool([
      [
        {
          id: "11111111-1111-1111-1111-111111111111",
          path: "memory/2026-05-20.md",
          logical_date: "2026-05-20",
          content: "DB daily content",
          content_sha256: "sha",
          source_kind: "legacy_import",
          source_path: "/workspace/memory/2026-05-20.md",
          metadata: {},
          created_at: "2026-05-20T10:00:00.000Z",
          updated_at: "2026-05-20T10:00:00.000Z",
        },
      ],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits,
      lookup: "db-memory/daily/11111111-1111-1111-1111-111111111111.md",
    });
    expect(got.ok).toBe(true);
    if (!got.ok) {
      throw new Error("expected successful result");
    }
    expect(got.path).toBe("db-memory/daily/11111111-1111-1111-1111-111111111111.md");
    expect(got.title).toBe("memory/2026-05-20.md");
    expect(got.kind).toBe("daily-note");
    expect(got.content).toContain("DB daily content");
  });

  it("hides internal-only session-capture rows from db-memory/daily lookups", async () => {
    const pool = createPool([
      [
        {
          id: "33333333-3333-3333-3333-333333333333",
          path: "memory/2026-06-03-0915-a1b2c3d4-session-capture.md",
          logical_date: "2026-06-03",
          content: "user: remember the reset capture canary",
          content_sha256: "sha",
          source_kind: "session_memory",
          source_path: null,
          metadata: {},
          created_at: "2026-06-03T09:15:00.000Z",
          updated_at: "2026-06-03T09:15:00.000Z",
        },
      ],
    ]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits,
      lookup: "db-memory/daily/33333333-3333-3333-3333-333333333333.md",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toBe("not found");
  });

  it("returns not found when a memory/* path has no canonical DB row", async () => {
    const pool = createPool([[]]);
    const got = await memoryGetFromDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits,
      lookup: "memory/2026-05-20.md",
    });
    expect(got.ok).toBe(false);
    if (got.ok) {
      throw new Error("expected failed result");
    }
    expect(got.error).toBe("not found");
  });
});
