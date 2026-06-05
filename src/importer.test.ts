import { beforeEach, describe, expect, it, vi } from "vitest";

const { readFile, readdir, mkdir, writeFile, rename, resolveScope } = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  resolveScope: vi.fn(async () => ({ userId: "user-1", workspaceId: "workspace-1" })),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile, readdir, mkdir, writeFile, rename },
  readFile,
  readdir,
  mkdir,
  writeFile,
  rename,
}));

vi.mock("./identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

import { runLegacyWorkspaceImport, runOneTimeWorkspaceImport, scanLegacyWorkspace } from "./importer.js";

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

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
    rename.mockResolvedValue(undefined);
  });

  it("imports MEMORY.md through batched inserts with local timeouts and cleanup", async () => {
    const content = ["# Long-Term Memory", "", "## Facts", "", "Alpha", "", "## Notes", "", "Beta"].join("\n");
    readFile.mockResolvedValue(content);

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
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
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
    readFile.mockResolvedValue(content);
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
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
    });

    expect(result.overall).toBe("degraded");
    expect(result.cleanup).toBe("failed");
    expect(result.reason).toContain("duplicate prompt injection risk remains");
  });

  it("skips reinserting when the same source hash already completed cleanly", async () => {
    const content = ["## Facts", "Alpha"].join("\n");
    readFile.mockResolvedValue(content);

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
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
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
    readFile.mockResolvedValue(content);

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
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
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

  it("re-stubs MEMORY.md when the same imported content reappears after previous cleanup", async () => {
    const content = ["## Facts", "Alpha"].join("\n");
    readFile.mockResolvedValue(content);

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
        if (text.includes("UPDATE memory_import_runs")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(),
    } as any;

    const result = await runOneTimeWorkspaceImport({
      api: createApi(),
      cfg: {
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
    });

    expect(result).toMatchObject({
      overall: "ready",
      import: "ready",
      cleanup: "completed",
      lastImportRunId: "run-existing",
    });
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("archives a same-sha daily file that reappears without reinserting DB rows", async () => {
    readFile.mockImplementation(async (targetPath: string) => {
      const normalizedPath = toPosixPath(targetPath);
      if (normalizedPath.endsWith("/MEMORY.md")) {
        throw new Error("missing");
      }
      if (normalizedPath.endsWith("/memory/2026-06-01.md")) {
        return "same daily content";
      }
      throw new Error(`unexpected path: ${targetPath}`);
    });
    readdir.mockResolvedValue([{ isFile: () => true, name: "2026-06-01.md" }] as any);

    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        if (text.includes("FROM memory_import_files")) {
          return { rows: [{ id: "file-1" }] };
        }
        if (text.includes("INSERT INTO memory_daily_entries")) {
          throw new Error("should not reinsert daily entry");
        }
        return { rows: [] };
      }),
      connect: vi.fn(),
    } as any;

    const result = await runLegacyWorkspaceImport({
      api: createApi(),
      cfg: {
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
      archiveImportedFiles: true,
    });

    expect(result.dailyImportedCount).toBe(0);
    expect(result.dailySkippedImportedCount).toBe(1);
    expect(result.dailyArchivedCount).toBe(1);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("reimports and archives a changed daily file when it reappears with a new sha", async () => {
    readFile.mockImplementation(async (targetPath: string) => {
      const normalizedPath = toPosixPath(targetPath);
      if (normalizedPath.endsWith("/MEMORY.md")) {
        throw new Error("missing");
      }
      if (normalizedPath.endsWith("/memory/2026-06-01.md")) {
        return "updated daily content";
      }
      throw new Error(`unexpected path: ${targetPath}`);
    });
    readdir.mockResolvedValue([{ isFile: () => true, name: "2026-06-01.md" }] as any);

    const queryCalls: string[] = [];
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        queryCalls.push(text);
        if (text.includes("FROM memory_import_files")) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO memory_daily_entries")) {
          return { rows: [{ id: "daily-row-1" }] };
        }
        if (text.includes("INSERT INTO memory_import_files")) {
          return { rows: [{ id: "ledger-row-1" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(),
    } as any;

    const result = await runLegacyWorkspaceImport({
      api: createApi(),
      cfg: {
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
      cleanupMemoryMdAfterImport: true,
      archiveImportedFiles: true,
    });

    expect(result.dailyImportedCount).toBe(1);
    expect(result.dailySkippedImportedCount).toBe(0);
    expect(result.dailyArchivedCount).toBe(1);
    expect(queryCalls.some((sql) => sql.includes("INSERT INTO memory_daily_entries"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("INSERT INTO memory_import_files"))).toBe(true);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("keeps legacy scan alive when one daily file is unreadable", async () => {
    readFile.mockImplementation(async (targetPath: string) => {
      const normalizedPath = toPosixPath(targetPath);
      if (normalizedPath.endsWith("/MEMORY.md")) {
        throw new Error("missing");
      }
      if (normalizedPath.endsWith("/memory/2026-06-01.md")) {
        return "daily content";
      }
      if (normalizedPath.endsWith("/memory/2026-06-02.md")) {
        throw new Error("EACCES");
      }
      throw new Error(`unexpected path: ${targetPath}`);
    });
    readdir.mockResolvedValue([
      { isFile: () => true, name: "2026-06-01.md" },
      { isFile: () => true, name: "2026-06-02.md" },
    ] as any);

    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as any;

    const result = await scanLegacyWorkspace({
      api: createApi(),
      cfg: {
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      workspaceDir: "/tmp/work",
      agentId: "main",
      sessionKey: "agent:main:test",
    });

    expect(result.dailyFiles).toHaveLength(2);
    expect(result.dailyFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "memory/2026-06-01.md",
          state: "pending",
          supported: true,
        }),
        expect.objectContaining({
          path: "memory/2026-06-02.md",
          state: "unreadable",
          supported: false,
          error: "EACCES",
        }),
      ]),
    );
    expect(result.unreadableCount).toBe(1);
    expect(result.pendingCount).toBe(1);
  });

  it("reads legacy files from sourceDir while resolving DB scope from targetWorkspaceDir", async () => {
    readFile.mockImplementation(async (targetPath: string) => {
      const normalizedPath = toPosixPath(targetPath);
      if (normalizedPath.endsWith("/legacy/MEMORY.md")) {
        return "## Facts\nAlpha";
      }
      throw new Error(`unexpected path: ${targetPath}`);
    });

    const pool = {
      query: vi.fn(async (sql?: string) => {
        const text = String(sql ?? "");
        if (text.includes("FROM memory_import_runs")) return { rows: [] };
        if (text.includes("SELECT attempt_count")) return { rows: [] };
        if (text.includes("INSERT INTO memory_import_runs")) return { rows: [{ id: "run-split" }] };
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
        postgres: { host: "localhost", database: "db", user: "user" },
      },
      pool,
      sourceDir: "/tmp/legacy",
      targetWorkspaceDir: "/tmp/target",
      agentId: "ops",
      cleanupMemoryMdAfterImport: false,
    });

    expect(result.import).toBe("ready");
    expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/\/tmp\/legacy\/MEMORY\.md$/), "utf8");
    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/target",
        agentId: "ops",
      }),
    );
  });
});
