import { describe, expect, it, vi } from "vitest";

import {
  hasSessionsIndexRows,
  memoryGetSessionFromIndexDb,
  memorySearchSessionsIndexDb,
  normalizeSessionLookupPath,
} from "./sessions-index.js";

type QueryCall = {
  sql: string;
  args: unknown[];
};

function createMockPool(rowsByCall: Array<unknown[]>) {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    const rows = rowsByCall.shift() ?? [];
    return { rows };
  });
  return { pool: { query } as any, calls, query };
}

describe("normalizeSessionLookupPath", () => {
  it("normalizes valid sessions path and backslashes", () => {
    expect(normalizeSessionLookupPath("sessions/main/a.jsonl")).toBe("sessions/main/a.jsonl");
    expect(normalizeSessionLookupPath("sessions\\main\\a.jsonl")).toBe("sessions/main/a.jsonl");
  });

  it("rejects invalid or unsafe shapes", () => {
    expect(normalizeSessionLookupPath("sessions/main")).toBeNull();
    expect(normalizeSessionLookupPath("sessions/main/a/b.jsonl")).toBeNull();
    expect(normalizeSessionLookupPath("sessions/main/..")).toBeNull();
    expect(normalizeSessionLookupPath("db-memory/items/x.md")).toBeNull();
  });
});

describe("hasSessionsIndexRows", () => {
  it("returns true when at least one indexed file exists", async () => {
    const { pool } = createMockPool([[{ id: "row-1" }]]);
    const got = await hasSessionsIndexRows({
      pool,
      userId: "u1",
      workspaceId: "w1",
    });
    expect(got).toBe(true);
  });

  it("returns false when no indexed files exist", async () => {
    const { pool } = createMockPool([[]]);
    const got = await hasSessionsIndexRows({
      pool,
      userId: "u1",
      workspaceId: "w1",
    });
    expect(got).toBe(false);
  });
});

describe("memoryGetSessionFromIndexDb", () => {
  it("returns null on index miss", async () => {
    const { pool } = createMockPool([[]]);
    const got = await memoryGetSessionFromIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      lookup: "sessions/main/miss.jsonl",
      limits: {
        maxResults: 10,
        getMaxChars: 12_000,
        getDefaultLines: 120,
        sessionsMaxFileBytes: 2_000_000,
        sessionsWrapChars: 800,
      },
    });
    expect(got).toBeNull();
  });

  it("returns bounded excerpt from indexed chunks", async () => {
    const { pool } = createMockPool([
      [{ id: "file-1" }],
      [{ text: "User: hello" }, { text: "Assistant: hi" }],
    ]);
    const got = await memoryGetSessionFromIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      lookup: "sessions/main/a.jsonl",
      fromLine: 1,
      lineCount: 50,
      limits: {
        maxResults: 10,
        getMaxChars: 12_000,
        getDefaultLines: 120,
        sessionsMaxFileBytes: 2_000_000,
        sessionsWrapChars: 800,
      },
    });
    expect(got).not.toBeNull();
    expect(got!.path).toBe("sessions/main/a.jsonl");
    expect(got!.text).toContain("User: hello");
    expect(got!.text).toContain("Assistant: hi");
  });
});

describe("memorySearchSessionsIndexDb", () => {
  it("maps DB rows to sessions hits", async () => {
    const { pool, query } = createMockPool([
      [
        {
          path: "sessions/main/a.jsonl",
          snippet: "User: hello",
          score: 0.42,
          start_line: 3,
          end_line: 3,
          updated_at: "2026-05-13T00:00:00.000Z",
        },
      ],
    ]);
    const hits = await memorySearchSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: {
        maxResults: 10,
        getMaxChars: 12_000,
        getDefaultLines: 120,
        sessionsMaxFileBytes: 2_000_000,
        sessionsWrapChars: 800,
      },
      query: "hello",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      corpus: "sessions",
      path: "sessions/main/a.jsonl",
      kind: "session",
      score: 0.42,
      startLine: 3,
      endLine: 3,
    });
  });
});
