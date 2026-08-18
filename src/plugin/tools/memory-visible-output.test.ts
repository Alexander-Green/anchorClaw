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

  it("marks daily hits as date-specific context in visible and structured output", () => {
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

    expect(visible).toContain("Scope: date-specific daily memory.");
    expect(details.results[0]?.snippet).toContain("Scope: date-specific daily memory.");
  });

  it("labels session-capture daily hits explicitly", () => {
    const visible = formatSearchLikeVisibleOutput({
      hits: [
        {
          corpus: "daily",
          path: "memory/2026-05-28-1819-a1b2c3d4-session-capture.md",
          title: "memory/2026-05-28-1819-a1b2c3d4-session-capture.md",
          snippet: "user: remember the reset marker",
          sourceKind: "session_memory",
          score: 0.9,
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

    expect(visible).toContain("Entry type: session capture from /new or /reset.");
  });

  it("preserves the indexed line range in visible and structured citations", () => {
    const params = {
      hits: [
        {
          corpus: "sessions",
          path: "sessions/main/session.jsonl",
          snippet: "matching transcript excerpt",
          score: 0.9,
          startLine: 5,
          endLine: 8,
        },
      ],
      retrievalMode: "sessions_index",
      queryMode: "contextual" as const,
      exactTop1: false,
      exactTop1Value: null,
      recommendedAction: "inspect_top" as const,
      provider: "anchorclaw",
      model: "postgres-fts",
    };

    const visible = formatSearchLikeVisibleOutput(params);
    const details = buildSearchLikeDetailsEnvelope(params);

    expect(visible).toContain("sessions/main/session.jsonl#L5-L8");
    expect(details.results[0]).toMatchObject({
      path: "sessions/main/session.jsonl",
      startLine: 5,
      endLine: 8,
      citation: "sessions/main/session.jsonl#L5-L8",
    });
  });
});
