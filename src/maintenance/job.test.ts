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

function buildEpisodicRow(content: string) {
  return {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    event_type: "user_prompt",
    content,
    created_at: "2026-05-20T00:00:00.000Z",
  };
}

function buildEpisodicRowWithId(id: string, content: string, createdAt = "2026-05-20T00:00:00.000Z") {
  return {
    id,
    event_type: "user_prompt",
    content,
    created_at: createdAt,
  };
}

describe("runMaintenanceCycle episodic", () => {
  beforeEach(() => {
    resolveUserAndWorkspaceScope.mockReset();
    extractMaintenanceCandidates.mockReset();
    memoryStoreDb.mockReset();
    resolveUserAndWorkspaceScope.mockResolvedValue({
      userId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("does not archive episodic rows in dryRun", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-1" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [
              {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                event_type: "user_prompt",
                content: "remember this decision for future work in this project",
                created_at: "2026-05-20T00:00:00.000Z",
              },
            ],
            rowCount: 1,
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
      dryRun: true,
      batchSize: 100,
    });

    expect(result.status).toBe("completed");
    expect(result.insertedCount).toBe(0);
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(false);
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
  });

  it("does not archive episodic rows when extractor is disabled", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-2" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [
              {
                id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                event_type: "user_prompt",
                content: "remember this preference for future tasks and decisions",
                created_at: "2026-05-20T00:00:00.000Z",
              },
            ],
            rowCount: 1,
          };
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
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(false);
    expect(extractMaintenanceCandidates).not.toHaveBeenCalled();
  });

  it("extracts, stores and archives episodic rows when extractor is enabled", async () => {
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
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [buildEpisodicRow("Please remember my favorite color is green")],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE memory_episodic")) {
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
    expect(memoryStoreDb).toHaveBeenCalledTimes(1);
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(true);
    expect(
      queries.some((sql) => sql.includes("regexp_replace(content, '\\s+', ' ', 'g')")),
    ).toBe(true);
  });

  it("fails without archiving episodic rows when a candidate store fails", async () => {
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
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [buildEpisodicRow("Please remember my favorite color is green")],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM memory_items")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE memory_episodic")) {
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
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(false);
  });

  it("archives only episodic rows that fit into the extractor transcript window", async () => {
    const extractorArgs: Array<{ transcript: string }> = [];
    extractMaintenanceCandidates.mockImplementation(async (params: { transcript: string }) => {
      extractorArgs.push({ transcript: params.transcript });
      return { summary: "summary", candidates: [] };
    });

    const archivedValues: unknown[][] = [];
    const firstRow = buildEpisodicRowWithId(
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "remember this project rule for future work",
      "2026-05-20T00:00:00.000Z",
    );
    const secondRow = buildEpisodicRowWithId(
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "remember this second rule that should stay pending because it is outside the transcript window",
      "2026-05-20T00:01:00.000Z",
    );
    const pool = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-5" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_episodic")) {
          return { rows: [firstRow, secondRow], rowCount: 2 };
        }
        if (sql.includes("UPDATE memory_episodic")) {
          archivedValues.push(values ?? []);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const cfg = buildCfg();
    cfg.maintenance.extractor.maxCharsPerRun = 120;
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
    expect(extractorArgs[0]?.transcript).toContain(firstRow.content);
    expect(extractorArgs[0]?.transcript).not.toContain(secondRow.content);
    expect(archivedValues).toHaveLength(1);
    expect(archivedValues[0]?.[2]).toEqual([firstRow.id]);
  });

  it("fails without archiving episodic rows when extractor output is malformed", async () => {
    extractMaintenanceCandidates.mockRejectedValue(new Error("extractor output.candidates must be an array"));

    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-6" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [buildEpisodicRow("Please remember my favorite color is green")],
            rowCount: 1,
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
      batchSize: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("extractor output.candidates must be an array");
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(false);
  });

  it("fails when maxCharsPerRun cannot fit even a single episodic row", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("INSERT INTO memory_maintenance_runs")) {
          return { rows: [{ id: "run-7" }], rowCount: 1 };
        }
        if (sql.includes("FROM memory_episodic")) {
          return {
            rows: [buildEpisodicRow("remember this project rule for future work")],
            rowCount: 1,
          };
        }
        if (sql.includes("UPDATE memory_maintenance_runs")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as any;

    const cfg = buildCfg();
    cfg.maintenance.extractor.maxCharsPerRun = 20;
    const result = await runMaintenanceCycle({
      api: buildApi(),
      cfg,
      pool,
      workspaceDir: "/workspace",
      dryRun: false,
      batchSize: 100,
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("maintenance transcript window too small");
    expect(queries.some((sql) => sql.includes("UPDATE memory_episodic"))).toBe(false);
  });
});
