import { describe, expect, it, vi } from "vitest";

import { memoryGetFromDb } from "./get.js";

vi.mock("./sessions.js", () => ({
  memoryGetSessionFile: vi.fn(),
}));

vi.mock("./sessions-index-sync.js", () => ({
  syncSessionsIndexDb: vi.fn(async () => undefined),
}));

import { memoryGetSessionFile } from "./sessions.js";

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
    const pool = createPool([[{ id: "f1" }], [{ text: "User: hello" }, { text: "Assistant: hi" }]]);
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
});

