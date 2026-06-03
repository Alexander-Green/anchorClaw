import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMaintenanceCycle } from "./job.js";

const resolveUserAndWorkspaceScope = vi.hoisted(() => vi.fn());
const extractMaintenanceCandidates = vi.hoisted(() => vi.fn());
const memoryStoreDb = vi.hoisted(() => vi.fn());

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope,
}));
vi.mock("./extractor.js", () => ({
  extractMaintenanceCandidates,
}));
vi.mock("../memory/store.js", () => ({
  memoryStoreDb,
}));

function buildApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn() },
  } as any;
}

function buildCfg() {
  return {
    workspaceDir: "/workspace",
    postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
    maintenance: {
      enabled: true,
      dryRun: false,
      intervalMinutes: 720,
      batchSize: 200,
      extractor: { enabled: true, agentId: "main", maxCandidates: 20, maxCharsPerRun: 12000 },
    },
  } as any;
}

function buildDailyRow(params: {
  id?: string;
  path?: string;
  logicalDate?: string;
  contentSha?: string;
  updatedAt?: string;
  sourceKind?: string;
  content: string;
}) {
  return {
    id: params.id ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    path: params.path ?? "memory/2026-05-20.md",
    logical_date: params.logicalDate ?? "2026-05-20",
    content: params.content,
    content_sha256: params.contentSha ?? "sha-1",
    source_kind: params.sourceKind ?? "memory_log",
    updated_at: params.updatedAt ?? "2026-05-20T00:00:00.000Z",
  };
}

describe("runMaintenanceCycle daily maintenance", () => {
  beforeEach(() => {
    resolveUserAndWorkspaceScope.mockReset();
    extractMaintenanceCandidates.mockReset();
    memoryStoreDb.mockReset();
    resolveUserAndWorkspaceScope.mockResolvedValue({
      userId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("does not mark processed windows in dryRun", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-1" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                content: "remember this project rule for future work and stable decisions",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg: buildCfg(),
      pool,
      workspaceDir: "/workspace",
      dryRun: true,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(result.scannedCount).toBe(1);
    expect(result.insertedCount).toBe(0);
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_extraction_windows"))).toBe(false);
  });

  it("does not mark processed windows when extractor is disabled", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-2" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                content: "remember this preference for future tasks and repeated work",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const cfg = buildCfg();
    cfg.maintenance.extractor.enabled = false;
    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg,
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(result.insertedCount).toBe(0);
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_extraction_windows"))).toBe(false);
  });

  it("extracts, stores, and marks processed daily windows", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [{ content: "User prefers green color.", type: "fact", canonicalKey: "favorite_color" }],
    });
    memoryStoreDb.mockResolvedValue({
      ok: true,
      corpus: "memory",
      path: "db-memory/items/xyz.md",
      id: "xyz",
      updatedAt: "now",
      created: true,
      version: 1,
    });

    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-3" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                content: "Please remember that the favorite color for UI accents is green.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg: buildCfg(),
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(result.insertedCount).toBe(1);
    expect(extractMaintenanceCandidates).toHaveBeenCalledTimes(1);
    expect(extractMaintenanceCandidates.mock.calls[0]?.[0]?.sourcePath).toBe("memory/2026-05-20.md#window=1");
    expect(memoryStoreDb).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_extraction_windows"))).toBe(true);
    expect(
      queries.some((sql) => sql.includes("regexp_replace(content, '\\s+', ' ', 'g')")),
    ).toBe(true);
  });

  it("filters extractor source rows to memory_log and legacy_import only", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [],
    });

    const queryCalls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queryCalls.push({ sql, values });
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-policy" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                id: "11111111-1111-1111-1111-111111111111",
                path: "memory/2026-06-01.md",
                sourceKind: "legacy_import",
                content: "remember this imported project rule for future work",
              }),
              buildDailyRow({
                id: "22222222-2222-2222-2222-222222222222",
                path: "memory/2026-06-02.md",
                sourceKind: "memory_log",
                content: "remember this current daily preference for future turns",
              }),
            ],
            rowCount: 2,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg: buildCfg(),
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    const dailyQuery = queryCalls.find((call) => call.sql.includes("FROM memory_daily_entries"));
    expect(dailyQuery?.values?.[2]).toEqual(["memory_log", "legacy_import"]);
    expect(extractMaintenanceCandidates).toHaveBeenCalledTimes(1);
    expect(extractMaintenanceCandidates.mock.calls[0]?.[0]?.transcript).toContain("imported project rule");
    expect(extractMaintenanceCandidates.mock.calls[0]?.[0]?.transcript).toContain("current daily preference");
  });

  it("fails without marking processed windows when a candidate store fails", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [
        { content: "User prefers green color.", type: "fact", canonicalKey: "favorite_color" },
        { content: "User hates purple color.", type: "note" },
      ],
    });
    memoryStoreDb
      .mockResolvedValueOnce({
        ok: true,
        corpus: "memory",
        path: "db-memory/items/xyz.md",
        id: "xyz",
        updatedAt: "now",
        created: true,
        version: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        error: "db write failed",
      });

    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-4" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                content: "Please remember my favorite color is green and avoid purple in most contexts.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg: buildCfg(),
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.insertedCount).toBe(1);
    expect(result.error).toContain("maintenance candidate store failed");
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_extraction_windows"))).toBe(false);
  });

  it("marks only windows that fit into the transcript limit", async () => {
    const extractorArgs: Array<{ transcript: string; sourcePath: string }> = [];
    extractMaintenanceCandidates.mockImplementation(
      async (params: { transcript: string; sourcePath: string }) => {
        extractorArgs.push(params);
        return { summary: "summary", candidates: [] };
      },
    );

    const recordedLedgerInserts: unknown[][] = [];
    const firstParagraph =
      "remember this project rule for future work and keep the implementation path stable for follow-up";
    const secondParagraph =
      "remember this second rule that should remain pending because it falls outside the current transcript window";
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-5" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                content: `${firstParagraph}\n\n${secondParagraph}`,
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_extraction_windows")) {
          recordedLedgerInserts.push(values ?? []);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const cfg = buildCfg();
    cfg.maintenance.extractor.maxCharsPerRun = 260;
    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg,
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(extractorArgs).toHaveLength(1);
    expect(extractorArgs[0]?.transcript).toContain(firstParagraph);
    expect(extractorArgs[0]?.transcript).not.toContain(secondParagraph);
    expect(recordedLedgerInserts).toHaveLength(1);
    expect(recordedLedgerInserts[0]?.[7]).toBe(0);
  });

  it("fails when extractor output is malformed", async () => {
    extractMaintenanceCandidates.mockRejectedValue(new Error("extractor output.candidates must be an array"));

    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-6" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_entries")) {
          return {
            rows: [
              buildDailyRow({
                content: "Please remember my favorite color is green for future UI work.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg: buildCfg(),
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("extractor output.candidates must be an array");
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_extraction_windows"))).toBe(false);
  });
});
