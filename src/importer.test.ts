import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFile, readdir, mkdir, writeFile, resolveScope } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  resolveScope: vi.fn(async () => ({ userId: "user-1", workspaceId: "workspace-1" })),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile, readdir, mkdir, writeFile },
  readFile,
  readdir,
  mkdir,
  writeFile,
}));

vi.mock("./identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

import { runOneTimeWorkspaceImport } from "./importer.js";

function createApi() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as any;
}

function extractInsertedItems(queryMock: ReturnType<typeof vi.fn>) {
  const insertCall = queryMock.mock.calls.find(([sql]) => String(sql ?? "").includes("INSERT INTO memory_items"));
  expect(insertCall).toBeTruthy();
  const params = insertCall?.[1] as unknown[];
  expect(Array.isArray(params)).toBe(true);

  const items = [];
  for (let idx = 0; idx < params.length; idx += 7) {
    items.push({
      userId: params[idx],
      workspaceId: params[idx + 1],
      type: params[idx + 2],
      title: params[idx + 3],
      content: params[idx + 4],
      metadata: params[idx + 5] ? JSON.parse(String(params[idx + 5])) : null,
      importKey: params[idx + 6],
    });
  }
  return items;
}

describe("runOneTimeWorkspaceImport Phase 3", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readdir.mockRejectedValue(new Error("missing"));
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
  });

  it("imports MEMORY.md through batched inserts with local timeouts and cleanup", async () => {
    const content = ["# Long-Term Memory", "", "## Facts", "", "Alpha", "", "## Notes", "", "Beta"].join("\n");
    readFile.mockResolvedValueOnce(content).mockResolvedValueOnce(content);

    const clientCalls: string[] = [];
    const poolCalls: string[] = [];
    const clientQuery = vi.fn(async (sql?: string) => {
      const text = String(sql ?? "");
      clientCalls.push(text);
      if (text.includes("INSERT INTO memory_items")) {
        return { rows: [{ id: "item-1" }, { id: "item-2" }] };
      }
      return { rows: [] };
    });
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        poolCalls.push(text);
        if (text.includes("FROM memory_import_runs")) return { rows: [] };
        if (text.includes("SELECT attempt_count")) return { rows: [] };
        if (text.includes("INSERT INTO memory_import_runs")) return { rows: [{ id: "run-1" }] };
        if (text.includes("UPDATE memory_import_runs")) return { rows: [] };
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    } as any;

    const result = await runOneTimeWorkspaceImport({
      api: createApi(),
      cfg: {
        workspaceDir: "/tmp/work",
        postgres: { host: "localhost", database: "db", user: "user" },
        import: { cleanupMemoryMdAfterImport: true },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
    });

    expect(result).toMatchObject({
      overall: "ready",
      import: "ready",
      cleanup: "completed",
      lastImportRunId: "run-1",
    });
    expect(clientCalls.some((sql) => sql.includes("SET LOCAL statement_timeout = '30000ms'"))).toBe(true);
    expect(clientCalls.some((sql) => sql.includes("SET LOCAL lock_timeout = '5000ms'"))).toBe(true);
    expect(clientCalls.some((sql) => sql.includes("import_key"))).toBe(true);
    expect(clientCalls.some((sql) => sql.includes("ON CONFLICT (user_id, workspace_id, import_key)"))).toBe(true);
    expect(poolCalls.some((sql) => sql.includes("INSERT INTO memory_import_runs"))).toBe(true);

    const insertedItems = extractInsertedItems(clientQuery);
    expect(insertedItems).toHaveLength(2);
    expect(insertedItems.map((item) => item.title)).toEqual(["Facts", "Notes"]);
    expect(insertedItems.map((item) => item.content)).toEqual(["Alpha", "Beta"]);
    expect(insertedItems[0]?.metadata).toMatchObject({
      legacy_heading_path: ["Long-Term Memory", "Facts"],
      legacy_format: "memory-md:v1",
    });
  });

  it("returns degraded when cleanup fails after successful import", async () => {
    const content = ["## Facts", "Alpha"].join("\n");
    readFile.mockResolvedValueOnce(content).mockResolvedValueOnce(content);
    writeFile.mockRejectedValueOnce(new Error("EACCES"));

    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        if (text.includes("FROM memory_import_runs")) return { rows: [] };
        if (text.includes("SELECT attempt_count")) return { rows: [] };
        if (text.includes("INSERT INTO memory_import_runs")) return { rows: [{ id: "run-2" }] };
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql?: string) => {
          const text = String(sql ?? "");
          if (text.includes("INSERT INTO memory_items")) {
            return { rows: [{ id: "item-1" }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
    } as any;

    const result = await runOneTimeWorkspaceImport({
      api: createApi(),
      cfg: {
        workspaceDir: "/tmp/work",
        postgres: { host: "localhost", database: "db", user: "user" },
        import: { cleanupMemoryMdAfterImport: true },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
    });

    expect(result.overall).toBe("degraded");
    expect(result.cleanup).toBe("failed");
    expect(result.reason).toContain("duplicate prompt injection risk remains");
  });

  it("skips reinserting when the same source hash already completed cleanly", async () => {
    const content = ["## Facts", "Alpha"].join("\n");
    readFile.mockResolvedValueOnce(content);

    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        if (text.includes("FROM memory_import_runs")) {
          return {
            rows: [
              {
                id: "run-existing",
                source_sha256: "same",
                status: "completed",
                cleanup_status: "completed",
                attempt_count: 1,
              },
            ],
          };
        }
        return { rows: [] };
      }),
      connect: vi.fn(),
    } as any;

    const result = await runOneTimeWorkspaceImport({
      api: createApi(),
      cfg: {
        workspaceDir: "/tmp/work",
        postgres: { host: "localhost", database: "db", user: "user" },
        import: { cleanupMemoryMdAfterImport: true },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
    });

    expect(result).toMatchObject({
      overall: "ready",
      import: "ready",
      cleanup: "completed",
      lastImportRunId: "run-existing",
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("creates multiple items under one heading without importing standalone headings", async () => {
    const content = [
      "# Long-Term Memory",
      "",
      "## Preferences",
      "",
      "Alex likes green.",
      "",
      "Alex prefers short answers.",
      "",
      "### Favorite color",
      "",
      "Green is the favorite color.",
    ].join("\n");
    readFile.mockResolvedValueOnce(content).mockResolvedValueOnce(content);

    const clientQuery = vi.fn(async (sql?: string) => {
      const text = String(sql ?? "");
      if (text.includes("INSERT INTO memory_items")) {
        return { rows: [{ id: "item-1" }, { id: "item-2" }, { id: "item-3" }] };
      }
      return { rows: [] };
    });
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        if (text.includes("FROM memory_import_runs")) return { rows: [] };
        if (text.includes("SELECT attempt_count")) return { rows: [] };
        if (text.includes("INSERT INTO memory_import_runs")) return { rows: [{ id: "run-3" }] };
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    } as any;

    const result = await runOneTimeWorkspaceImport({
      api: createApi(),
      cfg: {
        workspaceDir: "/tmp/work",
        postgres: { host: "localhost", database: "db", user: "user" },
        import: { cleanupMemoryMdAfterImport: true },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
    });

    expect(result.overall).toBe("ready");

    const insertedItems = extractInsertedItems(clientQuery);
    expect(insertedItems).toHaveLength(3);
    expect(insertedItems.map((item) => item.title)).toEqual([
      "Preferences",
      "Preferences",
      "Preferences > Favorite color",
    ]);
    expect(insertedItems.map((item) => item.content)).toEqual([
      "Alex likes green.",
      "Alex prefers short answers.",
      "Green is the favorite color.",
    ]);
    expect(insertedItems.some((item) => item.content === "# Long-Term Memory")).toBe(false);
    expect(insertedItems[0]?.metadata).toMatchObject({
      legacy_heading_path: ["Long-Term Memory", "Preferences"],
    });
    expect(insertedItems[2]?.metadata).toMatchObject({
      legacy_heading_path: ["Long-Term Memory", "Preferences", "Favorite color"],
    });
  });
});
