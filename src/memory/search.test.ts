import { describe, expect, it } from "vitest";
import { memorySearchDb } from "./search.js";

describe("memorySearchDb ranking contract", () => {
  it("uses exact-only boost and does not use broad LIKE boost", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql = sql;
        capturedParams = params;
        return { rows: [] as any[] };
      },
    } as any;

    await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      maxResults: 5,
    });

    expect(capturedSql).toContain("WHEN lower(coalesce(title, '')) = lower($3) THEN 3.0");
    expect(capturedSql).toContain("WHEN lower(content) = lower($3) THEN 2.5");
    expect(capturedSql).not.toContain("LIKE ('%' || lower($3) || '%')");
    expect(capturedSql).toContain("ORDER BY score DESC, importance DESC, updated_at DESC, id ASC");
    expect(capturedParams).toEqual(["u1", "w1", "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515", 5]);
  });

  it("keeps lexical FTS ranking path for broad queries", async () => {
    let capturedSql = "";
    const pool = {
      query: async (sql: string) => {
        capturedSql = sql;
        return { rows: [] as any[] };
      },
    } as any;

    await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "alpha",
      maxResults: 10,
    });

    expect(capturedSql).toContain("plainto_tsquery('simple', $3)");
    expect(capturedSql).toContain("ts_rank_cd(search_vector, plainto_tsquery('simple', $3))");
    expect(capturedSql).not.toContain("LIKE ('%' || lower($3) || '%')");
  });
});
