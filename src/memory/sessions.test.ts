import { describe, expect, it } from "vitest";

import { isSessionFileForAgent, memoryGetSessionFile } from "./sessions.js";

describe("sessions corpus (MVP)", () => {
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

  it("reads a sessions/<agentId>/<file> JSONL transcript and renders User/Assistant lines", async () => {
    // Use the same directory layout OpenClaw uses:
    // ~/.openclaw/agents/<agentId>/sessions/<file>.jsonl
    const tmp = process.env.TEMP ?? process.env.TMP ?? process.cwd();
    const stateDir = `${tmp}/anchorclaw-test-state`;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "main";
    const fileName = "session.jsonl";
    const sessionsDir = `${stateDir}/agents/${agentId}/sessions`;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });

    const lines = [
      JSON.stringify({ type: "session-meta", agentId }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello\nworld" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Hi there" } }),
    ];
    await writeFile(`${sessionsDir}/${fileName}`, lines.join("\n"), "utf8");

    const res = await memoryGetSessionFile({
      lookup: `sessions/${agentId}/${fileName}`,
      currentAgentId: agentId,
      defaultLines: 120,
      maxChars: 12_000,
      limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
    });

    expect(res).not.toBeNull();
    expect(res!.path).toBe(`sessions/${agentId}/${fileName}`);
    expect(res!.text).toContain("User: Hello world");
    expect(res!.text).toContain("Assistant: Hi there");
  });

  it("rejects session lookups with path separators in the file name", async () => {
    const tmp = process.env.TEMP ?? process.env.TMP ?? process.cwd();
    const stateDir = `${tmp}/anchorclaw-test-state-traversal`;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const agentId = "main";
    const escapedFileName = "outside.jsonl";
    const escapedDir = `${stateDir}/agents/${agentId}`;

    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(escapedDir, { recursive: true });
    await writeFile(
      `${escapedDir}/${escapedFileName}`,
      JSON.stringify({ type: "message", message: { role: "user", content: "should not read" } }),
      "utf8",
    );

    const res = await memoryGetSessionFile({
      lookup: `sessions/${agentId}/..\\${escapedFileName}`,
      currentAgentId: agentId,
      defaultLines: 120,
      maxChars: 12_000,
      limits: { sessionsMaxFileBytes: 2_000_000, sessionsWrapChars: 800 },
    });

    expect(res).toBeNull();
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
