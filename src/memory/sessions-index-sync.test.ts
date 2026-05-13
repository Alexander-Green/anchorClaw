import { beforeEach, describe, expect, it, vi } from "vitest";

const listSessionFilesForAgent = vi.fn();
const buildSessionEntry = vi.fn();
const sessionPathForFile = vi.fn();
const resolveSessionsDirForAgent = vi.fn();

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  listSessionFilesForAgent,
  buildSessionEntry,
  sessionPathForFile,
}));

vi.mock("./sessions.js", () => ({
  resolveSessionsDirForAgent,
}));

import { syncSessionsIndexDb } from "./sessions-index-sync.js";

type QueryCall = { sql: string; args: unknown[] };

function createMockPool(options: {
  probeRows?: Array<{ id: string; hash: string }>;
  existingRows?: Array<{ path: string }>;
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
    const staleDelete = calls.find(
      (call) =>
        call.sql.includes("DELETE FROM session_index_files") &&
        Array.isArray(call.args) &&
        call.args[2] === "sessions/main/old.jsonl",
    );
    expect(staleDelete).toBeDefined();
    expect(client.release).toHaveBeenCalledTimes(1);
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
});

