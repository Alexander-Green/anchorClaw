import { describe, expect, it } from "vitest";
import { compareMemorySearchHits } from "./ranking.js";

describe("compareMemorySearchHits", () => {
  it("accepts PostgreSQL Date timestamps when importance ties", () => {
    const older = {
      corpus: "memory" as const,
      path: "db-memory/items/older.md",
      importance: 50,
      score: 1,
      snippet: "older",
      updatedAt: new Date("2026-07-15T10:00:00.000Z"),
    };
    const newer = {
      corpus: "memory" as const,
      path: "db-memory/items/newer.md",
      importance: 50,
      score: 1,
      snippet: "newer",
      updatedAt: new Date("2026-07-15T11:00:00.000Z"),
    };

    expect([older, newer].sort(compareMemorySearchHits).map((hit) => hit.path)).toEqual([
      "db-memory/items/newer.md",
      "db-memory/items/older.md",
    ]);
  });
});
