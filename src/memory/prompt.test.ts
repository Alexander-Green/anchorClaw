import { describe, expect, it } from "vitest";

import { buildPromptDailySection, buildPromptMemorySection } from "./prompt.js";

describe("buildPromptMemorySection", () => {
  it("returns empty when no items", () => {
    expect(
      buildPromptMemorySection({
        items: [],
        maxTotalChars: 12_000,
        maxTitleChars: 120,
      }),
    ).toEqual([]);
  });

  it("respects per-item and total budgets", () => {
    const items = [
      {
        id: "1",
        type: "fact",
        title: "A title",
        content: "x".repeat(5_000),
        importance: 50,
        updatedAt: new Date().toISOString(),
      },
      {
        id: "2",
        type: "note",
        title: "B title",
        content: "y".repeat(5_000),
        importance: 50,
        updatedAt: new Date().toISOString(),
      },
    ];

    const lines = buildPromptMemorySection({
      items,
      maxTotalChars: 800, // small budget to force truncation
      maxTitleChars: 10,
      policy: {
        maxItemsByType: { fact: 6, note: 4 },
        defaultMaxItemChars: 200,
      },
    });
    const text = lines.join("\n");

    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain("## Durable Memory");
    expect(text).toContain("- (fact)");
    // body must be truncated to the policy budget
    expect(text).toMatch(/x{50,}/);
  });

  it("renders daily entries as transient daily context with bounded size", () => {
    const lines = buildPromptDailySection({
      entries: [
        {
          id: "d1",
          path: "memory/2026-05-20.md",
          content: "today we discussed sessions opt-in and daily injection".repeat(40),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      maxTotalChars: 900,
      maxPathChars: 80,
      maxEntryChars: 200,
    });
    const text = lines.join("\n");

    expect(text).toContain("## Daily Memory");
    expect(text).toContain("transient recent context");
    expect(text).toContain("memory/2026-05-20.md");
    expect(text.length).toBeLessThanOrEqual(900);
  });

  it("separates session captures from ordinary daily notes", () => {
    const lines = buildPromptDailySection({
      entries: [
        {
          id: "d1",
          path: "memory/2026-06-03.md",
          content: "today note",
          sourceKind: "memory_log",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: "s1",
          path: "memory/2026-06-03-0915-a1b2c3d4-session-capture.md",
          content: "assistant: long recap ".repeat(80),
          sourceKind: "session_memory",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      maxTotalChars: 1_400,
      maxPathChars: 80,
      maxEntryChars: 300,
      maxSessionCaptureEntryChars: 120,
      maxDailyEntries: 4,
      maxSessionCaptures: 2,
    });
    const text = lines.join("\n");

    expect(text).toContain("## Daily Memory (AnchorClaw/Postgres)");
    expect(text).toContain("memory/2026-06-03.md");
    expect(text).toContain("## Recent Session Captures");
    expect(text).toContain("prior-session context only");
    expect(text).toContain("memory/2026-06-03-0915-a1b2c3d4-session-capture.md");
    expect(text).not.toContain("assistant: long recap ".repeat(20));
  });
});
