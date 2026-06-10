import { describe, expect, it, vi } from "vitest";

import {
  appendDailyBlockDb,
  buildStartupMemoryDateStamps,
} from "./daily.js";

describe("buildStartupMemoryDateStamps", () => {
  it("returns local today and yesterday when UTC day matches", () => {
    expect(
      buildStartupMemoryDateStamps({
        nowMs: Date.parse("2026-06-03T10:00:00.000Z"),
        timezone: "UTC",
      }),
    ).toEqual(["2026-06-03", "2026-06-02"]);
  });

  it("prepends UTC day when it is ahead of the local calendar day", () => {
    expect(
      buildStartupMemoryDateStamps({
        nowMs: Date.parse("2026-06-03T00:30:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toEqual(["2026-06-03", "2026-06-02", "2026-06-01"]);
  });
});

describe("appendDailyBlockDb", () => {
  it("creates an immutable block together with a new canonical daily row", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, args: unknown[] = []) => {
        calls.push({ sql, args });
        if (sql === "BEGIN" || sql === "COMMIT") {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO memory_daily_entries")) {
          return {
            rows: [{
              id: "daily-1",
              content: "Today note",
              content_sha256: "daily-sha",
              source_kind: "memory_log",
              updated_at: "2026-06-10T10:00:00.000Z",
            }],
          };
        }
        if (sql.includes("max(block_index)")) {
          return { rows: [{ block_index: 0 }] };
        }
        if (sql.includes("INSERT INTO memory_daily_blocks")) {
          return { rows: [{ id: "block-1" }] };
        }
        if (sql.includes("INSERT INTO memory_audit_log")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as any;

    const result = await appendDailyBlockDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      logicalDate: "2026-06-10",
      path: "memory/2026-06-10.md",
      content: "Today note",
      sourceKind: "memory_log",
      actor: "tester",
    });

    expect(result).toMatchObject({
      ok: true,
      id: "daily-1",
      blockId: "block-1",
      created: true,
    });
    expect(calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("INSERT INTO memory_daily_blocks"))).toBe(true);
  });

  it("locks an existing daily row and marks mixed-source projection", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, args: unknown[] = []) => {
        calls.push({ sql, args });
        if (sql === "BEGIN" || sql === "COMMIT") {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO memory_daily_entries")) {
          return { rows: [] };
        }
        if (sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "daily-1",
              content: "User note",
              content_sha256: "old-sha",
              source_kind: "memory_log",
              updated_at: "2026-06-10T10:00:00.000Z",
            }],
          };
        }
        if (sql.includes("max(block_index)")) {
          return { rows: [{ block_index: 1 }] };
        }
        if (sql.includes("INSERT INTO memory_daily_blocks")) {
          return { rows: [{ id: "block-2" }] };
        }
        if (sql.includes("UPDATE memory_daily_entries")) {
          return { rows: [{ updated_at: "2026-06-10T10:05:00.000Z" }] };
        }
        if (sql.includes("INSERT INTO memory_audit_log")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
    } as any;

    const result = await appendDailyBlockDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      logicalDate: "2026-06-10",
      path: "memory/2026-06-10.md",
      content: "Compaction context",
      sourceKind: "compaction_flush",
      sourcePath: ".anchorclaw/flush-inbox/a.md",
    });

    expect(result).toMatchObject({
      ok: true,
      blockId: "block-2",
      created: false,
    });
    expect(calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
    const update = calls.find((call) => call.sql.includes("UPDATE memory_daily_entries"));
    expect(update?.args[2]).toBe("User note\n\nCompaction context");
    expect(update?.args[4]).toBe("mixed");
    expect(update?.args[5]).toBeNull();
  });

  it("rejects insert-only conflict without mutating the existing daily row", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO memory_daily_entries")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };

    const result = await appendDailyBlockDb({
      pool: { connect: vi.fn(async () => client) } as any,
      userId: "u1",
      workspaceId: "w1",
      logicalDate: "2026-06-10",
      path: "memory/2026-06-10.md",
      content: "Legacy snapshot",
      sourceKind: "legacy_import",
      conflictPolicy: "reject",
    });

    expect(result).toEqual({
      ok: false,
      error: "daily path already exists: memory/2026-06-10.md",
    });
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_daily_blocks"),
      expect.anything(),
    );
  });
});
