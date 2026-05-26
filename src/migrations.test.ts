import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { applyMigrations } from "./migrations.js";

describe("applyMigrations", () => {
  it("keeps 0007 search_text migration Postgres-compatible without generated columns", () => {
    const sql = readFileSync(new URL("../migrations/0007_memory_search_text.sql", import.meta.url), "utf8");

    expect(sql).toContain("ADD COLUMN IF NOT EXISTS search_text TEXT");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION memory_items_sync_search_text()");
    expect(sql).toContain("CREATE TRIGGER memory_items_search_text_sync");
    expect(sql).not.toContain("GENERATED ALWAYS AS");
    expect(sql).not.toContain("concat_ws(");
  });

  it("runs each migration inside a dedicated client transaction", async () => {
    const clientCalls: Array<{ sql: string; args: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, args: unknown[] = []) => {
        clientCalls.push({ sql, args });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT id, applied_at FROM schema_migrations")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => client),
    } as any;

    const got = await applyMigrations({
      pool,
      migrations: [{ filename: "0001_init.sql", sql: "CREATE TABLE demo(id int);" }],
    });

    expect(got).toEqual({ applied: ["0001"] });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(clientCalls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "CREATE TABLE demo(id int);",
      "INSERT INTO schema_migrations (id) VALUES ($1)",
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the client when a migration query fails", async () => {
    const clientCalls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        clientCalls.push(sql);
        if (sql === "BROKEN SQL") {
          throw new Error("boom");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT id, applied_at FROM schema_migrations")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => client),
    } as any;

    await expect(
      applyMigrations({
        pool,
        migrations: [{ filename: "0001_init.sql", sql: "BROKEN SQL" }],
      }),
    ).rejects.toThrow("boom");

    expect(clientCalls).toEqual(["BEGIN", "BROKEN SQL", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
