import { describe, expect, it } from "vitest";

import { parseMemoryLookupReference } from "./memory-lookup-reference.js";

describe("parseMemoryLookupReference", () => {
  it("parses a single-line citation without narrowing the default excerpt", () => {
    expect(parseMemoryLookupReference("sessions/main/session.jsonl#L5")).toEqual({
      lookup: "sessions/main/session.jsonl",
      fromLine: 5,
    });
  });

  it("parses a citation range", () => {
    expect(parseMemoryLookupReference("memory/2026-08-18.md#L5-L8")).toEqual({
      lookup: "memory/2026-08-18.md",
      fromLine: 5,
      lineCount: 4,
    });
  });

  it("leaves malformed and unrelated fragments untouched", () => {
    expect(parseMemoryLookupReference("sessions/main/session.jsonl#L8-L5")).toEqual({
      lookup: "sessions/main/session.jsonl#L8-L5",
    });
    expect(parseMemoryLookupReference("db-memory/items/id.md#section")).toEqual({
      lookup: "db-memory/items/id.md#section",
    });
    expect(parseMemoryLookupReference("memory/file.md#L1-L999999999999999999999")).toEqual({
      lookup: "memory/file.md#L1-L999999999999999999999",
    });
  });
});
