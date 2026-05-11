import { describe, expect, it } from "vitest";

import { buildPromptMemorySection } from "./prompt.js";

describe("buildPromptMemorySection", () => {
  it("returns empty when no items", () => {
    expect(
      buildPromptMemorySection({
        items: [],
        maxTotalChars: 12_000,
        maxItemChars: 1_200,
        maxTitleChars: 120,
      }),
    ).toEqual([]);
  });

  it("respects maxItemChars and maxTotalChars", () => {
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
      maxItemChars: 200,
      maxTitleChars: 10,
    });
    const text = lines.join("\n");
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain("## Durable Memory");
    expect(text).toContain("- (fact)");
    // content must be truncated to maxItemChars
    expect(text).toMatch(/x{50,}…/);
  });
});

