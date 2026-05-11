import { describe, expect, it } from "vitest";

import { buildMemoryReadResult } from "./read-file-shared.js";

describe("buildMemoryReadResult", () => {
  it("returns exact slice when within line+char budgets", () => {
    const res = buildMemoryReadResult({
      content: ["a", "b", "c", "d"].join("\n"),
      relPath: "db-memory/items/1.md",
      from: 2,
      lines: 2,
      defaultLines: 120,
      maxChars: 12_000,
    });

    expect(res).toEqual({
      text: ["b", "c"].join("\n"),
      path: "db-memory/items/1.md",
      from: 2,
      lines: 2,
    });
  });

  it("normalizes from/lines to be >= 1", () => {
    const res = buildMemoryReadResult({
      content: ["a", "b", "c"].join("\n"),
      relPath: "x",
      from: 0,
      lines: 0,
      defaultLines: 2,
      maxChars: 100,
    });

    expect(res.from).toBe(1);
    expect(res.lines).toBe(1);
    expect(res.text).toBe("a");
  });

  it("marks truncated and sets nextFrom when more lines remain", () => {
    const res = buildMemoryReadResult({
      content: ["a", "b", "c", "d"].join("\n"),
      relPath: "x",
      from: 1,
      lines: 2,
      defaultLines: 120,
      maxChars: 100,
    });

    expect(res.truncated).toBe(true);
    expect(res.nextFrom).toBe(3);
    expect(res.text).toContain("a\nb");
    expect(res.text).toContain("Use from=3 to continue");
  });

  it("trims lines to fit maxChars and reports nextFrom for continuation", () => {
    const res = buildMemoryReadResult({
      content: ["12345", "67890", "abcde"].join("\n"),
      relPath: "x",
      from: 1,
      lines: 3,
      defaultLines: 120,
      maxChars: 11, // fits "12345\n67890" (11 chars), but not + "\nabcde"
    });

    expect(res.lines).toBe(2);
    expect(res.truncated).toBe(true);
    expect(res.nextFrom).toBe(3);
    expect(res.text).toContain("12345\n67890");
  });

  it("hard-truncates a single long line and omits nextFrom", () => {
    const res = buildMemoryReadResult({
      content: "0123456789",
      relPath: "x",
      from: 1,
      lines: 1,
      defaultLines: 120,
      maxChars: 5,
    });

    expect(res.lines).toBe(1);
    expect(res.truncated).toBe(true);
    expect(res.nextFrom).toBeUndefined();
    expect(res.text).toBe(
      "01234\n\n[More content available. Requested excerpt exceeded the default maxChars budget.]",
    );
  });
});

