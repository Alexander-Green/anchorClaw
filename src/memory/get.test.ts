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
