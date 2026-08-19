import { describe, expect, it } from "vitest";

import {
  normalizeSessionCaptureMessages,
  parseStoredSessionCaptureMessages,
  sanitizeSessionCaptureText,
  selectRecentSessionCaptureMessages,
} from "./session-capture-content.js";

describe("session capture content", () => {
  it("applies the OpenClaw session-memory sanitization rules", () => {
    expect(sanitizeSessionCaptureText("NO_REPLY")).toBeNull();
    expect(sanitizeSessionCaptureText('{"action":"NO_REPLY"}')).toBeNull();
    expect(sanitizeSessionCaptureText("useful context\nNO_REPLY")).toBe("useful context");
    expect(
      sanitizeSessionCaptureText(
        [
          "before <|assistant|> after",
          "<|DSML|tool_calls>internal call</|DSML|tool_calls>",
          "<system>hidden directive</system>",
          "<assistant>hidden assistant wrapper</assistant>",
          "<media:image> (attachment)",
          "visible",
        ].join("\n"),
      ),
    ).toBe("before  after\nvisible");
  });

  it("filters inter-session messages and duplicate delivery mirrors before capture", () => {
    const messages = normalizeSessionCaptureMessages({
      messages: [
        { role: "user", content: "keep this" },
        { role: "assistant", content: "delivered answer" },
        {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: "delivered answer",
        },
        { role: "assistant", content: "NO_REPLY" },
        { role: "assistant", content: [{ type: "text", text: "final answer\nNO_REPLY" }] },
        { role: "assistant", content: "delivery protocol mentioned NO_REPLY in the middle" },
        {
          role: "user",
          content: "foreign completion",
          provenance: { kind: "inter_session" },
        },
      ],
      maxMessages: 15,
      maxMessageChars: 1_000,
    });

    expect(messages).toEqual([
      { role: "user", content: "keep this" },
      { role: "assistant", content: "delivered answer" },
      { role: "assistant", content: "final answer" },
      { role: "assistant", content: "delivery protocol mentioned  in the middle" },
    ]);
  });

  it("sanitizes legacy captures and removes every silent-reply token before injection", () => {
    const messages = parseStoredSessionCaptureMessages(
      [
        "## Session Capture - 2026-08-18T16:47:56.000Z",
        "- Source: OpenClaw before_reset",
        "",
        "### Conversation Summary",
        "assistant: NO_REPLY",
        "user: continue the story",
        "assistant: I used NO_REPLY after delivery, but the scene should continue.",
        "assistant: final scene beat",
        "assistant: final scene beat",
      ].join("\n"),
    );

    expect(messages).toEqual([
      { role: "user", content: "continue the story" },
      { role: "assistant", content: "I used  after delivery, but the scene should continue." },
      { role: "assistant", content: "final scene beat" },
    ]);
  });

  it("selects a contiguous tail of complete messages within the budget", () => {
    const messages = [
      { role: "user" as const, content: "old question" },
      { role: "assistant" as const, content: "old answer" },
      { role: "user" as const, content: "fresh question" },
      { role: "assistant" as const, content: "fresh answer" },
    ];
    const freshestPair = "user: fresh question\nassistant: fresh answer";
    const selected = selectRecentSessionCaptureMessages({
      messages,
      maxChars: freshestPair.length,
    });

    expect(selected).toBe(freshestPair);
    expect(selected).not.toContain("old question");
  });

  it("does not cut an oversized newest message in the middle", () => {
    expect(
      selectRecentSessionCaptureMessages({
        messages: [
          { role: "user", content: "short earlier message" },
          { role: "assistant", content: "x".repeat(200) },
        ],
        maxChars: 100,
      }),
    ).toBe("");
  });
});
