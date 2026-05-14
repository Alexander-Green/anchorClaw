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
    const tmp = process.env.TEMP ?? process.env.TMP ?? process.cwd();
    const stateDir = `${tmp}/anchorclaw-test-state`;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const agentId = "main";
    const fileName = "session.jsonl";
    const sessionsDir = `${stateDir}/agents/${agentId}/sessions`;
    const absPath = `${sessionsDir}/${fileName}`;

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
    const tmp = process.env.TEMP ?? process.env.TMP ?? process.cwd();
    const stateDir = `${tmp}/anchorclaw-test-state-agent-match`;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "main";
    const fileName = "match.jsonl";
    const sessionsDir = `${stateDir}/agents/${agentId}/sessions`;
    const absPath = `${sessionsDir}/${fileName}`;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(absPath, "", "utf8");

    const isMatch = await isSessionFileForAgent({
      sessionFile: absPath,
      agentId,
    });

    expect(isMatch).toBe(true);
  });

  it("rejects transcript files outside the current agent sessions dir", async () => {
    const tmp = process.env.TEMP ?? process.env.TMP ?? process.cwd();
    const stateDir = `${tmp}/anchorclaw-test-state-agent-mismatch`;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const currentAgentId = "main";
    const otherAgentId = "other";
    const otherSessionsDir = `${stateDir}/agents/${otherAgentId}/sessions`;
    const absPath = `${otherSessionsDir}/foreign.jsonl`;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(otherSessionsDir, { recursive: true });
    await writeFile(absPath, "", "utf8");

    const isMatch = await isSessionFileForAgent({
      sessionFile: absPath,
      agentId: currentAgentId,
    });

    expect(isMatch).toBe(false);
  });

  it("accepts lookup-style session path for the same agent", async () => {
    const isMatch = await isSessionFileForAgent({
      sessionFile: "sessions/main/a.jsonl",
      agentId: "main",
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
