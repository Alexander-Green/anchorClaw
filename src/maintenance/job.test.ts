import { beforeEach, describe, expect, it, vi } from "vitest";

import { runMaintenanceCycle } from "./job.js";

const resolveUserAndWorkspaceScope = vi.hoisted(() => vi.fn());
const extractMaintenanceCandidates = vi.hoisted(() => vi.fn());
const memoryStoreDb = vi.hoisted(() => vi.fn());
const processSemanticIndexingRequests = vi.hoisted(() => vi.fn());

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope,
}));
vi.mock("./extractor.js", () => ({
  extractMaintenanceCandidates,
}));
vi.mock("../memory/store.js", () => ({
  memoryStoreDb,
}));
vi.mock("../semantic/indexing.js", () => ({
  processSemanticIndexingRequests,
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
      extractor: { enabled: true, maxCandidates: 10, maxCharsPerRun: 12000 },
    },
  } as any;
}

function buildBlockRow(params: {
  id?: string;
  blockIndex?: number;
  path?: string;
  logicalDate?: string;
  sourceKind?: string;
  content: string;
}) {
  return {
    id: params.id ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    block_index: params.blockIndex ?? 0,
    daily_path: params.path ?? "memory/2026-05-20.md",
    logical_date: params.logicalDate ?? "2026-05-20",
    content: params.content,
    source_kind: params.sourceKind ?? "memory_log",
  };
}

describe("runMaintenanceCycle daily maintenance", () => {
  beforeEach(() => {
    resolveUserAndWorkspaceScope.mockReset();
    extractMaintenanceCandidates.mockReset();
    memoryStoreDb.mockReset();
    processSemanticIndexingRequests.mockReset();
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
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "remember this project rule for future work and stable decisions",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
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
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_block_extraction_windows"))).toBe(false);
  });

  it("does not mark processed windows when extractor is disabled", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-2" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "remember this preference for future tasks and repeated work",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
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
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_block_extraction_windows"))).toBe(false);
  });

  it("extracts, stores, and marks processed daily windows", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [
        {
          content: "User prefers green color.",
          type: "fact",
          canonicalKey: "favorite_color",
          confidence: 91,
        },
      ],
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
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "Please remember that the favorite color for UI accents is green.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
    expect(extractMaintenanceCandidates.mock.calls[0]?.[0]?.sourcePath).toBe(
      "memory/2026-05-20.md#block=1&window=1",
    );
    expect(memoryStoreDb).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_block_extraction_windows"))).toBe(true);
    expect(
      queries.some((sql) => sql.includes("regexp_replace(content, '\\s+', ' ', 'g')")),
    ).toBe(true);
  });

  it("processes semantic indexing requests after the daily extractor pass", async () => {
    processSemanticIndexingRequests.mockResolvedValueOnce({
      processedRequests: 1,
      indexed: 2,
      requeued: 0,
      superseded: 0,
      failed: 0,
    });
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-semantic" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;
    const cfg = buildCfg();
    cfg.semantic = { enabled: true };
    const api = {
      ...buildApi(),
      runtime: {
        config: {
          current: () => ({ agents: { list: [{ id: "main" }] } }),
        },
      },
    } as any;

    const result = await runMaintenanceCycle({
      api,
      cfg,
      pool,
      workspaceDir: "/workspace",
      agentId: "main",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(result.semanticRequestCount).toBe(1);
    expect(result.semanticIndexedCount).toBe(2);
    expect(result.semanticFailedCount).toBe(0);
    expect(processSemanticIndexingRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "11111111-1111-1111-1111-111111111111",
        workspaceId: "22222222-2222-2222-2222-222222222222",
        itemBatchSize: 25,
      }),
    );
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes("UPDATE memory_maintenance_runs"))).toBe(true);
  });

  it("filters extractor source rows to memory_log only", async () => {
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
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                id: "22222222-2222-2222-2222-222222222222",
                path: "memory/2026-06-02.md",
                sourceKind: "memory_log",
                content: "remember this current daily preference for future turns",
              }),
            ],
            rowCount: 2,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
    const dailyQuery = queryCalls.find((call) => call.sql.includes("FROM memory_daily_blocks"));
    expect(dailyQuery?.values?.[2]).toEqual(["memory_log"]);
    expect(extractMaintenanceCandidates).toHaveBeenCalledTimes(1);
    expect(extractMaintenanceCandidates.mock.calls[0]?.[0]?.transcript).toContain("current daily preference");
  });

  it("skips candidates without high confidence", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [
        { content: "Stable but unscored item", type: "fact" },
        { content: "Low confidence item", type: "note", confidence: 79 },
        { content: "Accepted item", type: "fact", canonicalKey: "accepted", confidence: 88 },
      ],
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

    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-confidence" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "remember this durable project rule for future work and stable decisions",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
    expect(result.skippedCount).toBe(2);
    expect(memoryStoreDb).toHaveBeenCalledTimes(1);
    expect(memoryStoreDb).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          content: "Accepted item",
          confidence: 88,
        }),
      }),
    );
  });

  it("fails without marking processed windows when a candidate store fails", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [
        {
          content: "User prefers green color.",
          type: "fact",
          canonicalKey: "favorite_color",
          confidence: 93,
        },
        { content: "User hates purple color.", type: "note", confidence: 85 },
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
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "Please remember my favorite color is green and avoid purple in most contexts.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
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
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_block_extraction_windows"))).toBe(false);
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
      "remember this project rule for future work and keep the implementation path stable for follow-up".padEnd(
        768,
        "x",
      );
    const secondParagraph =
      "remember this second rule that should remain pending because it falls outside the current transcript window";
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-5" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                content: `${firstParagraph}\n\n${secondParagraph}`,
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
    cfg.maintenance.extractor.maxCharsPerRun = 1_000;
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

  it("overlaps stable block windows so boundary-spanning facts remain visible", async () => {
    extractMaintenanceCandidates.mockResolvedValue({
      summary: "summary",
      candidates: [],
    });

    const recordedLedgerInserts: unknown[][] = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-overlap" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                content: "x".repeat(800),
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
    cfg.maintenance.extractor.maxCharsPerRun = 2_000;
    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg,
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(recordedLedgerInserts).toHaveLength(2);
    expect(recordedLedgerInserts.map((values) => values[7])).toEqual([0, 1]);
    expect(recordedLedgerInserts.map((values) => values[9])).toEqual([0, 640]);
    expect(recordedLedgerInserts.map((values) => values[10])).toEqual([768, 800]);
  });

  it("does not mix different daily files into one extractor transcript", async () => {
    const extractorArgs: Array<{ transcript: string; sourcePath: string }> = [];
    extractMaintenanceCandidates.mockImplementation(
      async (params: { transcript: string; sourcePath: string }) => {
        extractorArgs.push(params);
        return { summary: "summary", candidates: [] };
      },
    );

    const recordedLedgerInserts: unknown[][] = [];
    const firstFileRule =
      "remember this first-file project rule for future work and keep it durable across sessions";
    const secondFileRule =
      "remember this second-file project rule even though it would also fit into the same char budget";
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-7" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                path: "memory/2026-05-20.md",
                content: firstFileRule,
              }),
              buildBlockRow({
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                path: "memory/2026-05-21.md",
                logicalDate: "2026-05-21",
                content: secondFileRule,
              }),
            ],
            rowCount: 2,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
          recordedLedgerInserts.push(values ?? []);
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
    expect(result.scannedCount).toBe(1);
    expect(extractorArgs).toHaveLength(1);
    expect(extractorArgs[0]?.transcript).toContain(firstFileRule);
    expect(extractorArgs[0]?.transcript).not.toContain(secondFileRule);
    expect(extractorArgs[0]?.sourcePath).toBe("memory/2026-05-20.md#block=1&window=1");
    expect(recordedLedgerInserts).toHaveLength(1);
    expect(recordedLedgerInserts[0]?.[4]).toBe("memory/2026-05-20.md");
  });

  it("pages past fully processed oldest rows to reach newer pending daily work", async () => {
    const extractorArgs: Array<{ transcript: string; sourcePath: string }> = [];
    extractMaintenanceCandidates.mockImplementation(
      async (params: { transcript: string; sourcePath: string }) => {
        extractorArgs.push(params);
        return { summary: "summary", candidates: [] };
      },
    );

    const queryCalls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queryCalls.push({ sql, values });
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-paging" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          const offset = Number(values?.[4] ?? 0);
          if (offset === 0) {
            return {
              rows: [
                buildBlockRow({
                  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  path: "memory/2026-05-20.md",
                  content: "remember this old rule that has already been processed before",
                }),
              ],
              rowCount: 1,
            };
          }
          return {
            rows: [
              buildBlockRow({
                id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                path: "memory/2026-05-21.md",
                logicalDate: "2026-05-21",
                content: "remember this newer rule that should still be extracted now",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          const entryIds = values?.[2] as string[] | undefined;
          if (entryIds?.includes("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")) {
            return {
              rows: [
                {
                  daily_block_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  pipeline_version: 1,
                  window_index: 0,
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("INSERT INTO memory_daily_block_extraction_windows")) {
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
      batchSize: 1,
    });

    expect(result.status).toBe("completed");
    expect(result.scannedCount).toBe(1);
    expect(extractorArgs).toHaveLength(1);
    expect(extractorArgs[0]?.sourcePath).toBe("memory/2026-05-21.md#block=1&window=1");
    expect(extractorArgs[0]?.transcript).toContain("newer rule");
    const dailyQueries = queryCalls.filter((call) => call.sql.includes("FROM memory_daily_blocks"));
    expect(dailyQueries).toHaveLength(2);
    expect(dailyQueries[0]?.values?.[4]).toBe(0);
    expect(dailyQueries[1]?.values?.[4]).toBe(1);
  });

  it("completes without extractor calls when all paged daily rows are already processed", async () => {
    const queryCalls: Array<{ sql: string; values?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queryCalls.push({ sql, values });
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-no-pending" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_daily_blocks")) {
          const offset = Number(values?.[4] ?? 0);
          if (offset === 0) {
            return {
              rows: [
                buildBlockRow({
                  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                  path: "memory/2026-05-20.md",
                  content: "remember this already-processed rule from the first page",
                }),
              ],
              rowCount: 1,
            };
          }
          if (offset === 1) {
            return {
              rows: [
                buildBlockRow({
                  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                  path: "memory/2026-05-21.md",
                  logicalDate: "2026-05-21",
                  content: "remember this already-processed rule from the second page too",
                }),
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
          const entryIds = values?.[2] as string[] | undefined;
          return {
            rows: (entryIds ?? []).map((id) => ({
              daily_block_id: id,
              pipeline_version: 1,
              window_index: 0,
            })),
            rowCount: entryIds?.length ?? 0,
          };
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
      batchSize: 1,
    });

    expect(result.status).toBe("completed");
    expect(result.scannedCount).toBe(0);
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
    const dailyQueries = queryCalls.filter((call) => call.sql.includes("FROM memory_daily_blocks"));
    expect(dailyQueries).toHaveLength(3);
    expect(dailyQueries[0]?.values?.[4]).toBe(0);
    expect(dailyQueries[1]?.values?.[4]).toBe(1);
    expect(dailyQueries[2]?.values?.[4]).toBe(2);
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
        if (sql.includes("FROM memory_daily_blocks")) {
          return {
            rows: [
              buildBlockRow({
                content: "Please remember my favorite color is green for future UI work.",
              }),
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_daily_block_extraction_windows")) {
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
    expect(queries.some((sql) => sql.includes("INSERT INTO memory_daily_block_extraction_windows"))).toBe(false);
  });
});
