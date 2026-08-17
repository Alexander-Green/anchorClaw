import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  listSessionFilesForAgent,
  buildSessionEntry,
  sessionPathForFile,
  resolveSessionsDirForAgent,
} = vi.hoisted(() => ({
  listSessionFilesForAgent: vi.fn(),
  buildSessionEntry: vi.fn(),
  sessionPathForFile: vi.fn(),
  resolveSessionsDirForAgent: vi.fn(),
}));

vi.mock("./legacy-session-files.js", () => ({
  listLegacySessionFilesForAgent: listSessionFilesForAgent,
  buildLegacySessionEntry: buildSessionEntry,
  legacySessionPathForFile: sessionPathForFile,
}));

vi.mock("./sessions.js", () => ({
  resolveSessionsDirForAgent,
}));

import { syncSessionsIndexDb, syncVisibleSessionsIndexDb } from "./sessions-index-sync.js";

type QueryCall = { sql: string; args: unknown[] };

function createMockPool(options: {
  probeRows?: Array<{ id: string; hash: string }>;
  existingRows?: Array<{ path: string }>;
  existingRowsByPrefix?: Record<string, Array<{ path: string }>>;
  upsertId?: string;
}) {
  const calls: QueryCall[] = [];
  const clientCalls: QueryCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, args: unknown[] = []) => {
      clientCalls.push({ sql, args });
      if (sql.includes("RETURNING id")) {
        return { rows: [{ id: options.upsertId ?? "file-1" }] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    calls.push({ sql, args });
    if (sql.includes("SELECT id, hash")) {
      return { rows: options.probeRows ?? [] };
    }
    if (sql.includes("SELECT path") && sql.includes("FROM session_index_files")) {
      if (typeof args[2] === "string" && options.existingRowsByPrefix?.[args[2] as string]) {
        return { rows: options.existingRowsByPrefix[args[2] as string] ?? [] };
      }
      return { rows: options.existingRows ?? [] };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => client);
  return { pool: { query, connect } as any, calls, clientCalls, connect, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncSessionsIndexDb", () => {
  it("skips unchanged files by hash without opening transaction", async () => {
    listSessionFilesForAgent.mockResolvedValueOnce(["/sessions/a.jsonl"]);
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/main/a.jsonl",
      hash: "h1",
      content: "User: hi",
      lineMap: [1],
      messageTimestampsMs: [0],
      mtimeMs: 1,
      size: 10,
    });
    const { pool, connect } = createMockPool({
      probeRows: [{ id: "file-1", hash: "h1" }],
      existingRows: [{ path: "sessions/main/a.jsonl" }],
    });

    const got = await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
    });

    expect(got).toEqual({
      indexedFiles: 0,
      updatedFiles: 0,
      skippedFiles: 1,
      removedFiles: 0,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("removes stale indexed files during full sync", async () => {
    listSessionFilesForAgent.mockResolvedValueOnce(["/sessions/a.jsonl"]);
    sessionPathForFile.mockReturnValue("/sdk/sessions/a.jsonl");
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/main/a.jsonl",
      hash: "h2",
      content: "User: hi\nAssistant: hey",
      lineMap: [1, 2],
      messageTimestampsMs: [1, 2],
      mtimeMs: 2,
      size: 20,
      generatedByCronRun: false,
      generatedByDreamingNarrative: false,
    });
    const { pool, calls, clientCalls, client } = createMockPool({
      probeRows: [],
      existingRows: [{ path: "sessions/main/a.jsonl" }, { path: "sessions/main/old.jsonl" }],
      upsertId: "file-22",
    });

    const got = await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
    });

    expect(got).toEqual({
      indexedFiles: 1,
      updatedFiles: 0,
      skippedFiles: 0,
      removedFiles: 1,
    });
    expect(client.query).toHaveBeenCalled();
    expect(clientCalls.some((call) => call.sql.includes("BEGIN"))).toBe(true);
    expect(clientCalls.some((call) => call.sql.includes("COMMIT"))).toBe(true);
    const staleProbe = calls.find((call) => call.sql.includes("SELECT path") && call.sql.includes("FROM session_index_files"));
    expect(staleProbe?.sql).toContain("path LIKE $3");
    expect(staleProbe?.args).toEqual(["u1", "w1", "sessions/main/%"]);
    const staleDelete = calls.find(
      (call) =>
        call.sql.includes("DELETE FROM session_index_files") &&
        Array.isArray(call.args) &&
        call.args[2] === "sessions/main/old.jsonl",
    );
    expect(staleDelete).toBeDefined();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("escapes wildcard characters in stale cleanup agent prefix", async () => {
    listSessionFilesForAgent.mockResolvedValueOnce([]);
    const { pool, calls } = createMockPool({
      probeRows: [],
      existingRowsByPrefix: {
        "sessions/agent\\_a\\%prod/%": [],
      },
    });

    await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "agent_a%prod",
    });

    const staleProbe = calls.find(
      (call) => call.sql.includes("SELECT path") && call.sql.includes("FROM session_index_files"),
    );
    expect(staleProbe?.args).toEqual(["u1", "w1", "sessions/agent\\_a\\%prod/%"]);
  });

  it("does not run stale cleanup for targeted sync", async () => {
    resolveSessionsDirForAgent.mockResolvedValue("/root/.openclaw/agents/main/sessions");
    sessionPathForFile.mockReturnValue("/sdk/sessions/a.jsonl");
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/main/a.jsonl",
      hash: "h3",
      content: "User: ping",
      lineMap: [3],
      messageTimestampsMs: [3],
      mtimeMs: 3,
      size: 30,
    });
    const { pool, calls } = createMockPool({
      probeRows: [],
      existingRows: [{ path: "sessions/main/old.jsonl" }],
    });

    const got = await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionFiles: ["sessions/main/a.jsonl"],
    });

    expect(got.removedFiles).toBe(0);
    expect(calls.some((call) => call.sql.includes("SELECT path") && call.sql.includes("FROM session_index_files"))).toBe(
      false,
    );
  });

  it("stores agent_id from session path during cross-agent targeted sync", async () => {
    resolveSessionsDirForAgent.mockResolvedValue("/root/.openclaw/agents/main/sessions");
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/other/a.jsonl",
      hash: "h4",
      content: "User: ping",
      lineMap: [3],
      messageTimestampsMs: [3],
      mtimeMs: 3,
      size: 30,
    });
    const { pool, clientCalls } = createMockPool({
      probeRows: [],
      existingRows: [],
    });

    await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionFiles: ["sessions/other/a.jsonl"],
    });

    const fileUpsert = clientCalls.find((call) => call.sql.includes("INSERT INTO session_index_files"));
    expect(fileUpsert).toBeDefined();
    expect(fileUpsert?.args[2]).toBe("other");

    const chunkInsert = clientCalls.find((call) => call.sql.includes("INSERT INTO session_index_chunks"));
    expect(chunkInsert).toBeDefined();
    expect(chunkInsert?.args[3]).toBe("other");
  });

  it("resolves sessions directory once per agent during targeted sync normalization", async () => {
    resolveSessionsDirForAgent.mockImplementation(async (agentId: string) => `/root/.openclaw/agents/${agentId}/sessions`);
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/other/a.jsonl",
      hash: "h5",
      content: "User: one",
      lineMap: [1],
      messageTimestampsMs: [1],
      mtimeMs: 1,
      size: 10,
    });
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/other/b.jsonl",
      hash: "h6",
      content: "User: two",
      lineMap: [2],
      messageTimestampsMs: [2],
      mtimeMs: 2,
      size: 20,
    });
    const { pool } = createMockPool({
      probeRows: [],
      existingRows: [],
    });

    await syncSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      sessionFiles: ["sessions/other/a.jsonl", "sessions/other/b.jsonl"],
    });

    const callsForMain = resolveSessionsDirForAgent.mock.calls.filter((call) => call[0] === "main");
    const callsForOther = resolveSessionsDirForAgent.mock.calls.filter((call) => call[0] === "other");
    expect(callsForMain).toHaveLength(1);
    expect(callsForOther).toHaveLength(1);
  });

  it("removes stale indexed files for each agent during visible full sync", async () => {
    listSessionFilesForAgent.mockImplementation(async (agentId: string) =>
      agentId === "main" ? ["/sessions/main-a.jsonl"] : ["/sessions/other-b.jsonl"],
    );
    sessionPathForFile.mockImplementation((value: string) => `/sdk/${value}`);
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/main/a.jsonl",
      hash: "main-hash",
      content: "User: main",
      lineMap: [1],
      messageTimestampsMs: [1],
      mtimeMs: 1,
      size: 10,
    });
    buildSessionEntry.mockResolvedValueOnce({
      path: "sessions/other/b.jsonl",
      hash: "other-hash",
      content: "User: other",
      lineMap: [2],
      messageTimestampsMs: [2],
      mtimeMs: 2,
      size: 20,
    });
    const { pool, calls } = createMockPool({
      probeRows: [],
      existingRowsByPrefix: {
        "sessions/main/%": [{ path: "sessions/main/a.jsonl" }, { path: "sessions/main/stale.jsonl" }],
        "sessions/other/%": [{ path: "sessions/other/b.jsonl" }, { path: "sessions/other/stale.jsonl" }],
      },
    });

    const got = await syncVisibleSessionsIndexDb({
      pool,
      userId: "u1",
      workspaceId: "w1",
      agentId: "main",
      otherAgentIds: ["other"],
      force: true,
    });

    expect(got).toEqual({
      indexedFiles: 2,
      updatedFiles: 0,
      skippedFiles: 0,
      removedFiles: 2,
    });
    expect(listSessionFilesForAgent).toHaveBeenCalledTimes(2);
    expect(listSessionFilesForAgent).toHaveBeenNthCalledWith(1, "main");
    expect(listSessionFilesForAgent).toHaveBeenNthCalledWith(2, "other");
    expect(
      calls.filter(
        (call) =>
          call.sql.includes("DELETE FROM session_index_files") &&
          Array.isArray(call.args) &&
          (call.args[2] === "sessions/main/stale.jsonl" || call.args[2] === "sessions/other/stale.jsonl"),
      ),
    ).toHaveLength(2);
  });
});
