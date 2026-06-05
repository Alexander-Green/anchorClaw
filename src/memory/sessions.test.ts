import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSessionEntry, listSessionFilesForAgent, sessionPathForFile } = vi.hoisted(() => ({
  buildSessionEntry: vi.fn(),
  listSessionFilesForAgent: vi.fn(),
  sessionPathForFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
}));

import { isSessionFileForAgent, memoryGetSessionFile, memorySearchSessions } from "./sessions.js";

async function withTempEnvDir<T>(
  envName: "OPENCLAW_STATE_DIR" | "OPENCLAW_HOME",
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const previous = process.env[envName];
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    process.env[envName] = dir;
    return await fn(dir);
  } finally {
    if (previous === undefined) {
      delete process.env[envName];
    } else {
      process.env[envName] = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sessions corpus (MVP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-sessions lookups", async () => {
    const res = await memoryGetSessionFile({
      lookup: "db-memory/items/11111111-2222-3333-4444-555555555555.md",
      currentAgentId: "main",
      defaultLines: 120,
      maxChars: 12_000,
      limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
    });
    expect(res).toBeNull();
  });

  it("reads sessions/<agentId>/<file> through SDK buildSessionEntry and sessionPathForFile", async () => {
    await withTempEnvDir("OPENCLAW_STATE_DIR", "anchorclaw-test-state-", async (stateDir) => {
      const agentId = "main";
      const fileName = "session.jsonl";
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      const absPath = path.join(sessionsDir, fileName);

      vi.mocked(buildSessionEntry).mockResolvedValueOnce({
        path: `sessions/${agentId}/${fileName}`,
        absPath,
        mtimeMs: 10,
        size: 100,
        hash: "hash-1",
        content: "User: Hello world\nAssistant: Hi there",
        lineMap: [2, 4],
        messageTimestampsMs: [1000, 2000],
      } as any);
      vi.mocked(sessionPathForFile).mockReturnValueOnce(`sessions/${agentId}/${fileName}`);

      const res = await memoryGetSessionFile({
        lookup: `sessions/${agentId}/${fileName}`,
        currentAgentId: agentId,
        defaultLines: 120,
        maxChars: 12_000,
        limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
      });

      expect(buildSessionEntry).toHaveBeenCalledWith(absPath);
      expect(res).not.toBeNull();
      expect(res!.path).toBe(`sessions/${agentId}/${fileName}`);
      expect(res!.text).toContain("User: Hello world");
      expect(res!.text).toContain("Assistant: Hi there");
    });
  });

  it("uses JSONL lineMap coordinates for fallback memory_get pagination", async () => {
    await withTempEnvDir("OPENCLAW_STATE_DIR", "anchorclaw-test-state-linemap-", async (stateDir) => {
      const agentId = "main";
      const fileName = "session-line-map.jsonl";
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      const absPath = path.join(sessionsDir, fileName);

      vi.mocked(buildSessionEntry).mockResolvedValueOnce({
        path: `sessions/${agentId}/${fileName}`,
        absPath,
        mtimeMs: 10,
        size: 100,
        hash: "hash-2",
        content: "User: one\nAssistant: two",
        lineMap: [3, 7],
        messageTimestampsMs: [1000, 2000],
      } as any);
      vi.mocked(sessionPathForFile).mockReturnValueOnce(`sessions/${agentId}/${fileName}`);

      const res = await memoryGetSessionFile({
        lookup: `sessions/${agentId}/${fileName}`,
        currentAgentId: agentId,
        fromLine: 7,
        lineCount: 1,
        defaultLines: 120,
        maxChars: 12_000,
        limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
      });

      expect(res).not.toBeNull();
      expect(res!.from).toBe(7);
      expect(res!.lines).toBe(1);
      expect(res!.text).toContain("Assistant: two");
      expect(res!.text).not.toContain("User: one");
    });
  });

  it("uses strict numeric from/lineCount range for sparse lineMap values", async () => {
    await withTempEnvDir("OPENCLAW_STATE_DIR", "anchorclaw-test-state-linemap-sparse-", async (stateDir) => {
      const agentId = "main";
      const fileName = "session-line-map-sparse.jsonl";
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      const absPath = path.join(sessionsDir, fileName);

      vi.mocked(buildSessionEntry).mockResolvedValueOnce({
        path: `sessions/${agentId}/${fileName}`,
        absPath,
        mtimeMs: 10,
        size: 100,
        hash: "hash-3",
        content: "line 10\nline 20\nline 30",
        lineMap: [10, 20, 30],
        messageTimestampsMs: [1000, 2000, 3000],
      } as any);
      vi.mocked(sessionPathForFile).mockReturnValueOnce(`sessions/${agentId}/${fileName}`);

      const res = await memoryGetSessionFile({
        lookup: `sessions/${agentId}/${fileName}`,
        currentAgentId: agentId,
        fromLine: 10,
        lineCount: 5,
        defaultLines: 120,
        maxChars: 12_000,
        limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
      });

      expect(res).not.toBeNull();
      expect(res!.from).toBe(10);
      expect(res!.lines).toBe(1);
      expect(res!.text).toContain("line 10");
      expect(res!.text).not.toContain("line 20");
      expect(res!.nextFrom).toBe(20);
    });
  });

  it("rejects session lookups with path separators in the file name", async () => {
    const res = await memoryGetSessionFile({
      lookup: "sessions/main/..\\outside.jsonl",
      currentAgentId: "main",
      defaultLines: 120,
      maxChars: 12_000,
      limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
    });

    expect(res).toBeNull();
    expect(buildSessionEntry).not.toHaveBeenCalled();
  });

  it("uses lineMap values in fallback search hits", async () => {
    vi.mocked(listSessionFilesForAgent).mockResolvedValueOnce(["/state/agents/main/sessions/a.jsonl"]);
    vi.mocked(buildSessionEntry).mockResolvedValueOnce({
      path: "sessions/main/a.jsonl",
      absPath: "/state/agents/main/sessions/a.jsonl",
      mtimeMs: 123,
      size: 20,
      hash: "hash-2",
      content: "User: one\nAssistant: needle reply",
      lineMap: [3, 7],
      messageTimestampsMs: [111, 222],
    } as any);
    vi.mocked(sessionPathForFile).mockReturnValueOnce("sessions/main/a.jsonl");

    const hits = await memorySearchSessions({
      query: "needle",
      maxResults: 5,
      agentId: "main",
      limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
    });

    expect(listSessionFilesForAgent).toHaveBeenCalledWith("main");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      path: "sessions/main/a.jsonl",
      startLine: 7,
      endLine: 7,
    });
  });

  it("detects that a transcript file belongs to the current agent sessions dir", async () => {
    await withTempEnvDir("OPENCLAW_STATE_DIR", "anchorclaw-test-state-agent-match-", async (stateDir) => {
      const agentId = "main";
      const fileName = "match.jsonl";
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      const absPath = path.join(sessionsDir, fileName);

      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(absPath, "", "utf8");

      const isMatch = await isSessionFileForAgent({
        sessionFile: absPath,
        agentId,
      });

      expect(isMatch).toBe(true);
    });
  });

  it("rejects transcript files outside the current agent sessions dir", async () => {
    await withTempEnvDir("OPENCLAW_STATE_DIR", "anchorclaw-test-state-agent-mismatch-", async (stateDir) => {
      const currentAgentId = "main";
      const otherAgentId = "other";
      const otherSessionsDir = path.join(stateDir, "agents", otherAgentId, "sessions");
      const absPath = path.join(otherSessionsDir, "foreign.jsonl");

      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(otherSessionsDir, { recursive: true });
      await writeFile(absPath, "", "utf8");

      const isMatch = await isSessionFileForAgent({
        sessionFile: absPath,
        agentId: currentAgentId,
      });

      expect(isMatch).toBe(false);
    });
  });

  it("resolves state dir from OPENCLAW_HOME when OPENCLAW_STATE_DIR is unset", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      delete process.env.OPENCLAW_STATE_DIR;
      await withTempEnvDir("OPENCLAW_HOME", "anchorclaw-openclaw-home-", async (homeDir) => {
        const agentId = "main";
        const sessionsDir = path.join(homeDir, ".openclaw", "agents", agentId, "sessions");
        const absPath = path.join(sessionsDir, "home-based.jsonl");
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(absPath, "", "utf8");

        const isMatch = await isSessionFileForAgent({
          sessionFile: absPath,
          agentId,
        });

        expect(isMatch).toBe(true);
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
    }
  });

  it("accepts lookup-style session path for the same agent", async () => {
    const isMatch = await isSessionFileForAgent({
      sessionFile: "sessions/main/a.jsonl",
      agentId: "main",
    });

    expect(isMatch).toBe(true);
  });

  it("normalizes lookup-style agent ids with upstream semantics", async () => {
    const isMatch = await isSessionFileForAgent({
      sessionFile: "sessions/team.alpha/a.jsonl",
      agentId: "team-alpha",
    });

    expect(isMatch).toBe(true);
  });

  it("rejects lookup-style session path for a different agent", async () => {
    const isMatch = await isSessionFileForAgent({
      sessionFile: "sessions/other/a.jsonl",
      agentId: "main",
    });

    expect(isMatch).toBe(false);
  });
});
