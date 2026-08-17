import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildLegacySessionEntry,
  isLegacyUsageCountedSessionTranscriptFileName,
  legacySessionPathForFile,
  listLegacySessionFilesForAgent,
} from "./legacy-session-files.js";

const tempDirs: string[] = [];

async function createTempState(): Promise<{ stateDir: string; sessionsDir: string }> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "anchorclaw-legacy-sessions-"));
  tempDirs.push(stateDir);
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return { stateDir, sessionsDir };
}

function messageLine(role: "user" | "assistant", content: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    type: "message",
    message: { role, content, ...extra },
  });
}

afterEach(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("legacy session files", () => {
  it("builds a bounded user/assistant projection with source line coordinates", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "turn.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ type: "message", message: { role: "user", content: "hello legacy" } }),
        JSON.stringify({ type: "message", message: { role: "tool", content: "hidden tool" } }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            provenance: { kind: "inter_session" },
            content: "hidden relay",
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-06-01T12:00:00Z",
          message: { role: "assistant", content: [{ type: "text", text: "legacy reply" }] },
        }),
      ].join("\n"),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry).not.toBeNull();
    expect(entry?.path).toBe("sessions/main/turn.jsonl");
    expect(entry?.content).toBe("User: hello legacy\nAssistant: legacy reply");
    expect(entry?.lineMap).toEqual([1, 4]);
    expect(entry?.messageTimestampsMs[1]).toBe(Date.parse("2026-06-01T12:00:00Z"));
  });

  it("rejects oversized transcripts instead of partially indexing them", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "large.jsonl");
    await fs.writeFile(sessionFile, "x".repeat(128), "utf8");

    await expect(buildLegacySessionEntry(sessionFile, { maxFileBytes: 64 })).resolves.toBeNull();
  });

  it("lists primary and usage-counted archive transcripts only", async () => {
    const { stateDir, sessionsDir } = await createTempState();
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await Promise.all(
      [
        "active.jsonl",
        "active.jsonl.reset.2026-06-01T12-00-00Z",
        "active.jsonl.bak.2026-06-01T12-00-00Z",
        "active.checkpoint.not-a-uuid.jsonl",
        "active.checkpoint.123e4567-e89b-12d3-a456-426614174000.jsonl",
        "active.trajectory.jsonl",
      ].map((name) => fs.writeFile(path.join(sessionsDir, name), "", "utf8")),
    );

    const files = await listLegacySessionFilesForAgent("main");

    expect(files.map((file) => path.basename(file)).sort()).toEqual([
      "active.checkpoint.not-a-uuid.jsonl",
      "active.jsonl",
      "active.jsonl.reset.2026-06-01T12-00-00Z",
    ]);
    expect(isLegacyUsageCountedSessionTranscriptFileName("active.jsonl")).toBe(true);
    expect(legacySessionPathForFile(files[0]!)).toMatch(/^sessions\/main\//u);
  });

  it("strips legacy and marked inbound metadata while preserving user text", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "metadata.jsonl");
    const jsonBlock = (label: string, value: Record<string, unknown>) =>
      `${label}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
    const content = [
      "[Mon 2026-08-17 10:15 UTC]",
      "Context:",
      "<active_memory_plugin>",
      "do not index recalled memory",
      "</active_memory_plugin>",
      jsonBlock("Conversation info (untrusted metadata):", { chat_id: "123" }),
      jsonBlock("Sender (untrusted metadata):", { username: "alice" }),
      jsonBlock("Thread starter (untrusted, for context):", { body: "old thread" }),
      jsonBlock("Reply target of current user message (untrusted, for context):", {
        body: "old reply",
      }),
      jsonBlock("Forwarded message context (untrusted metadata):", { from: "mallory" }),
      jsonBlock("Location (untrusted metadata):", { latitude: 1, longitude: 2 }),
      jsonBlock("Custom channel data: ⟦openclaw:ctx⟧", { injected: "ignore me" }),
      "Delivery: to send a message, use the `message` tool.",
      "actual user request",
    ].join("\n");
    await fs.writeFile(sessionFile, messageLine("user", content), "utf8");

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.content).toBe("User: actual user request");
  });

  it("removes internal runtime context blocks without dropping surrounding user text", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "runtime-context.jsonl");
    await fs.writeFile(
      sessionFile,
      messageLine(
        "user",
        [
          "keep before",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "private runtime event",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
          "keep after",
        ].join("\n"),
      ),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.content).toBe("User: keep before keep after");
  });

  it("removes legacy internal task completion events and untrusted child results", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "legacy-runtime-context.jsonl");
    await fs.writeFile(
      sessionFile,
      messageLine(
        "user",
        [
          "keep before",
          "",
          "OpenClaw runtime context (internal):",
          "This context is runtime-generated, not user-authored. Keep internal details private.",
          "",
          "[Internal task completion event]",
          "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>",
          "private child output",
          "<<<END_UNTRUSTED_CHILD_RESULT>>>",
          "",
          "Action:",
          "Continue the active task.",
          "",
          "keep after",
        ].join("\n"),
      ),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.content).toBe("User: keep before keep after");
    expect(entry?.content).not.toContain("private child output");
  });

  it("filters heartbeat, silent-reply, exec completion, and inter-session noise", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "noise.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        messageLine("user", "[OpenClaw heartbeat poll]"),
        messageLine("assistant", "HEARTBEAT_OK"),
        messageLine("assistant", '{"action":"NO_REPLY"}'),
        messageLine("user", "Exec finished: background command"),
        messageLine("user", "Exec completed (job_1, code 0) :: done"),
        messageLine("assistant", "visible answer"),
      ].join("\n"),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.content).toBe("Assistant: visible answer");
  });

  it("uses exact OpenClaw cron-run classification and maps archives to their primary session", async () => {
    const { sessionsDir } = await createTempState();
    const primary = path.join(sessionsDir, "cron-session.jsonl");
    const archive = path.join(
      sessionsDir,
      "cron-session.jsonl.reset.2026-06-01T12-00-00Z",
    );
    await fs.writeFile(primary, messageLine("assistant", "cron output"), "utf8");
    await fs.writeFile(archive, messageLine("assistant", "archived cron output"), "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:cron:job-1:run:run-1": {
          sessionId: "cron-session",
        },
      }),
      "utf8",
    );

    const primaryEntry = await buildLegacySessionEntry(primary);
    const archiveEntry = await buildLegacySessionEntry(archive);

    expect(primaryEntry?.generatedByCronRun).toBe(true);
    expect(primaryEntry?.content).toBe("");
    expect(archiveEntry?.generatedByCronRun).toBe(true);
    expect(archiveEntry?.content).toBe("");
  });

  it("does not classify a normal cron namespace as a completed cron run", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "cron-base.jsonl");
    await fs.writeFile(
      sessionFile,
      [messageLine("user", "[cron:job-1] generated prompt"), messageLine("assistant", "keep result")].join(
        "\n",
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ "agent:main:cron:job-1": { sessionId: "cron-base" } }),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.generatedByCronRun).toBeUndefined();
    expect(entry?.content).toBe("Assistant: keep result");
  });

  it("detects dreaming transcripts from nested generated records", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "dreaming.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ data: { runId: "dreaming-narrative-run-1" } }),
        messageLine("assistant", "private narrative"),
      ].join("\n"),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.generatedByDreamingNarrative).toBe(true);
    expect(entry?.content).toBe("");
  });

  it("returns an empty stable entry for compaction checkpoints", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(
      sessionsDir,
      "active.checkpoint.123e4567-e89b-12d3-a456-426614174000.jsonl",
    );
    await fs.writeFile(sessionFile, messageLine("user", "must not index"), "utf8");

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry).toMatchObject({ content: "", lineMap: [], messageTimestampsMs: [] });
    expect(entry?.hash).toHaveLength(64);
  });

  it("does not split a UTF-16 surrogate pair at the wrapping boundary", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "unicode.jsonl");
    const original = `${"a".repeat(79)}😀tail`;
    await fs.writeFile(sessionFile, messageLine("user", original), "utf8");

    const entry = await buildLegacySessionEntry(sessionFile, { wrapChars: 80 });
    const restored = entry?.content
      .split("\n")
      .map((line) => line.replace(/^User: /u, ""))
      .join("");

    expect(restored).toBe(original);
    expect(entry?.content).not.toContain("�");
  });

  it("rejects non-finite file and wrapping limits", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "invalid-limits.jsonl");
    await fs.writeFile(sessionFile, messageLine("user", "safe text"), "utf8");

    await expect(buildLegacySessionEntry(sessionFile, { wrapChars: Number.NaN })).resolves.toBeNull();
    await expect(
      buildLegacySessionEntry(sessionFile, { maxFileBytes: Number.POSITIVE_INFINITY }),
    ).resolves.toBeNull();
  });

  it("redacts credential-like text before it reaches the index", async () => {
    const { sessionsDir } = await createTempState();
    const sessionFile = path.join(sessionsDir, "secret.jsonl");
    const secret = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
    await fs.writeFile(
      sessionFile,
      messageLine("user", `Authorization: Bearer ${secret}`),
      "utf8",
    );

    const entry = await buildLegacySessionEntry(sessionFile);

    expect(entry?.content).not.toContain(secret);
    expect(entry?.content).toContain("…");
  });

  it("rejects symlink transcript targets", async () => {
    const { sessionsDir } = await createTempState();
    const target = path.join(sessionsDir, "target.jsonl");
    const link = path.join(sessionsDir, "link.jsonl");
    await fs.writeFile(target, messageLine("user", "target"), "utf8");
    await fs.symlink(target, link);

    await expect(buildLegacySessionEntry(link)).resolves.toBeNull();
  });
});
