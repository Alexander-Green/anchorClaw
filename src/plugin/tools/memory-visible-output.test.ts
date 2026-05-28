import { describe, expect, it } from "vitest";

import { buildSearchLikeDetailsEnvelope, formatSearchLikeVisibleOutput } from "./memory-visible-output.js";

describe("memory search visible output", () => {
  it("includes canonical key hints for durable memory hits", () => {
    const visible = formatSearchLikeVisibleOutput({
      hits: [
        {
          corpus: "memory",
          path: "db-memory/items/1.md",
          title: "Favorite color: green",
          snippet: "Favorite color: green",
          canonicalKey: "favorite_color",
          score: 0.8,
        },
      ],
      retrievalMode: "fts_memory",
      queryMode: "contextual",
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top",
      provider: "anchorclaw",
      model: "postgres-fts",
    });

    expect(visible).toContain("Canonical key: favorite_color");
  });

  it("marks daily hits as one-day context in visible and structured output", () => {
    const visible = formatSearchLikeVisibleOutput({
      hits: [
        {
          corpus: "daily",
          path: "memory/2026-05-28.md",
          title: "memory/2026-05-28.md",
          snippet: "28 May 2026: planning meeting.",
          score: 0.5,
        },
      ],
      retrievalMode: "fts_daily",
      queryMode: "contextual",
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top",
      provider: "anchorclaw",
      model: "postgres-fts",
    });
    const details = buildSearchLikeDetailsEnvelope({
      hits: [
        {
          corpus: "daily",
          path: "memory/2026-05-28.md",
          title: "memory/2026-05-28.md",
          snippet: "28 May 2026: planning meeting.",
          score: 0.5,
        },
      ],
      retrievalMode: "fts_daily",
      queryMode: "contextual",
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top",
      provider: "anchorclaw",
      model: "postgres-fts",
    });

    expect(visible).toContain("daily memory is one-day context");
    expect(details.results[0]?.snippet).toContain("daily memory is one-day context");
  });
});
