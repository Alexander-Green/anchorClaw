import { describe, expect, it } from "vitest";
import { memorySearchDailyDb, memorySearchDb } from "./search.js";

describe("memorySearchDb ranking contract", () => {
  it("uses exact boosts on title/content/canonical key in the strict FTS path", async () => {
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql.push(sql);
        capturedParams.push(params);
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

    expect(capturedSql[0]).toContain("WHEN lower(coalesce(title, '')) = lower($3) THEN 3.0");
    expect(capturedSql[0]).toContain("WHEN lower(content) = lower($3) THEN 2.5");
    expect(capturedSql[0]).toContain("WHEN lower(coalesce(canonical_key, '')) = lower($3) THEN 2.25");
    expect(capturedSql[0]).toContain("to_tsvector('simple', search_text) @@ q.ts_query");
    expect(capturedSql[0]).toContain("ORDER BY score DESC, importance DESC, updated_at DESC, id ASC");
    expect(capturedSql[1]).toContain("FROM memory_daily_entries");
    expect(capturedParams[1]).toEqual([
      "u1",
      "w1",
      "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      5,
      ["session_memory"],
    ]);
  });

  it("keeps lexical FTS ranking path for broad queries", async () => {
    const capturedSql: string[] = [];
    const pool = {
      query: async (sql: string) => {
        capturedSql.push(sql);
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

    expect(capturedSql[0]).toContain("plainto_tsquery('simple', $3)");
    expect(capturedSql[0]).toContain("ts_rank_cd(to_tsvector('simple', search_text), q.ts_query)");
    expect(capturedSql[2]).toContain("word_similarity(lower($3), lower(search_text))");
  });

  it("falls back to relaxed phrase/token queries when strict multi-term FTS returns no hits", async () => {
    const queried: string[] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        const query = String(params[2]);
        queried.push(query);
        if (query === "active memory") {
          return {
            rows: [
              {
                id: "marker",
                title: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
                type: "note",
                content: "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
                updated_at: "2026-05-15T17:28:07.403Z",
                score: 1.54,
              },
            ],
          };
        }
        if (query === "smoke") {
          return {
            rows: [
              {
                id: "smoke",
                title: "anchorclaw post-restart smoke",
                type: "note",
                content: "anchorclaw post-restart smoke",
                updated_at: "2026-05-12T00:00:38.583Z",
                score: 1.4,
              },
            ],
          };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "active memory smoke",
      maxResults: 5,
    });

    expect(queried).toContain("active memory smoke");
    expect(queried).toContain("active memory");
    expect(queried).toContain("smoke");
    expect(hits.map((hit) => hit.title)).toEqual([
      "ANCHORCLAW_ACTIVE_MEMORY_MARKER_20260515",
      "anchorclaw post-restart smoke",
    ]);
    expect(hits[0]?.relaxedQuery).toBe("active memory");
  });

  it("uses unicode relaxed queries for Russian natural-language questions", async () => {
    const queried: string[] = [];
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        const query = String(params[2]);
        queried.push(query);
        if (query === "любимый цвет") {
          return {
            rows: [
              {
                id: "color",
                title: "Любимый цвет: зеленый",
                type: "fact",
                content: "Любимый цвет: зеленый",
                updated_at: "2026-05-21T14:27:00.000Z",
                score: 1.8,
              },
            ],
          };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "Какой мой любимый цвет?",
      maxResults: 5,
    });

    expect(queried).toContain("Какой мой любимый цвет?");
    expect(queried).toContain("любимый цвет");
    expect(queried).not.toContain("какой мой");
    expect(hits[0]).toMatchObject({
      title: "Любимый цвет: зеленый",
      relaxedQuery: "любимый цвет",
    });
  });

  it("uses fuzzy fallback to recover close lexical forms after strict FTS miss", async () => {
    const capturedSql: string[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql.push(sql);
        if (capturedSql.length === 3) {
          expect(String(params[2])).toBe("Сабира");
          return {
            rows: [
              {
                id: "sabira-color",
                title: "Любимый цвет Сабиры — жёлтый.",
                type: "fact",
                content: "Любимый цвет Сабиры — жёлтый.",
                canonical_key: "sabira_favorite_color",
                updated_at: "2026-05-26T11:37:29.000Z",
                score: 0.91,
              },
            ],
          };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "Сабира",
      maxResults: 5,
    });

    expect(capturedSql[2]).toContain("word_similarity(lower($3), lower(search_text))");
    expect(capturedSql[2]).toContain("similarity(lower(search_text), lower($3))");
    expect(hits[0]).toMatchObject({
      title: "Любимый цвет Сабиры — жёлтый.",
      path: "db-memory/items/sabira-color.md",
      canonicalKey: "sabira_favorite_color",
    });
  });

  it("returns imported daily hits in memory corpus with legacy daily path", async () => {
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        if (String(sql).includes("FROM memory_items")) {
          return { rows: [] as any[] };
        }
        if (String(sql).includes("FROM memory_daily_entries")) {
          return {
            rows: [
              {
                id: "daily-1",
                path: "memory/2026-05-20.md",
                content: "today we discussed daily memory behavior",
                source_kind: "legacy_import",
                updated_at: "2026-05-20T09:00:00.000Z",
                score: 0.8,
              },
            ],
          };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "daily memory",
      maxResults: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      corpus: "daily",
      path: "memory/2026-05-20.md",
      kind: "daily-note",
      sourceKind: "legacy_import",
      title: "memory/2026-05-20.md",
    });
  });

  it("excludes session-capture daily rows from memory corpus results", async () => {
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql.push(sql);
        capturedParams.push(params);
        if (String(sql).includes("FROM memory_items")) {
          return { rows: [] as any[] };
        }
        if (String(sql).includes("FROM memory_daily_entries")) {
          return { rows: [] as any[] };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "reset capture canary",
      maxResults: 5,
    });

    expect(hits).toHaveLength(0);
    const dailySql = capturedSql.find((sql) => sql.includes("FROM memory_daily_entries"));
    expect(dailySql).toContain("source_kind <> ALL($5::text[])");
    expect(capturedParams.find((params) => Array.isArray(params[4])))?.toEqual([
      "u1",
      "w1",
      "reset capture canary",
      5,
      ["session_memory"],
    ]);
  });

  it("keeps durable hits ahead of daily hits on equal score", async () => {
    const pool = {
      query: async (sql: string) => {
        if (String(sql).includes("FROM memory_items")) {
          return {
            rows: [
              {
                id: "item-1",
                title: "Team decision",
                type: "note",
                content: "team decision content",
                updated_at: "2026-05-20T10:00:00.000Z",
                score: 1,
              },
            ],
          };
        }
        if (String(sql).includes("FROM memory_daily_entries")) {
          return {
            rows: [
              {
                id: "daily-1",
                path: "memory/2026-05-20.md",
                content: "team decision content",
                source_kind: "memory_log",
                updated_at: "2026-05-20T11:00:00.000Z",
                score: 1,
              },
            ],
          };
        }
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "team decision",
      maxResults: 5,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]?.path).toBe("db-memory/items/item-1.md");
    expect(hits[1]?.path).toBe("memory/2026-05-20.md");
  });

  it("excludes session-capture daily rows from daily corpus results", async () => {
    const capturedSql: string[] = [];
    const capturedParams: unknown[][] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        capturedSql.push(sql);
        capturedParams.push(params);
        return { rows: [] as any[] };
      },
    } as any;

    const hits = await memorySearchDailyDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      limits: { maxResults: 10 } as any,
      query: "reset capture canary",
      maxResults: 5,
    });

    expect(hits).toHaveLength(0);
    expect(capturedSql[0]).toContain("source_kind <> ALL($5::text[])");
    expect(capturedParams[0]).toEqual([
      "u1",
      "w1",
      "reset capture canary",
      5,
      ["session_memory"],
    ]);
  });
});
