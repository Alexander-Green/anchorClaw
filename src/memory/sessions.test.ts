import { describe, expect, it } from "vitest";

import { memoryGetSessionFile } from "./sessions.js";

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
});
