import { describe, expect, it } from "vitest";

import { parseDbMemoryPath } from "./paths.js";

describe("parseDbMemoryPath", () => {
  it("parses item path", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(parseDbMemoryPath(`db-memory/items/${uuid}.md`)).toEqual({ kind: "item", id: uuid });
  });

  it("parses event path", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(parseDbMemoryPath(`db-memory/events/${uuid}.md`)).toEqual({ kind: "event", id: uuid });
  });

  it("parses export path", () => {
    expect(parseDbMemoryPath("db-memory/export/MEMORY.md")).toEqual({ kind: "export", name: "MEMORY.md" });
  });

  it("trims whitespace and tolerates extra slashes", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(parseDbMemoryPath(`  /db-memory//items/${uuid}.md  `)).toEqual({ kind: "item", id: uuid });
  });

  it("rejects non-md items/events", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(parseDbMemoryPath(`db-memory/items/${uuid}.txt`)).toBeNull();
    expect(parseDbMemoryPath(`db-memory/events/${uuid}.txt`)).toBeNull();
  });

  it("rejects invalid uuid", () => {
    expect(parseDbMemoryPath("db-memory/items/not-a-uuid.md")).toBeNull();
    expect(parseDbMemoryPath("db-memory/events/not-a-uuid.md")).toBeNull();
  });

  it("rejects unknown roots and shapes", () => {
    expect(parseDbMemoryPath("items/11111111-2222-3333-4444-555555555555.md")).toBeNull();
    expect(parseDbMemoryPath("db-memory/items")).toBeNull();
    expect(parseDbMemoryPath("db-memory/export/OTHER.md")).toBeNull();
    expect(parseDbMemoryPath("db-memory/unknown/123.md")).toBeNull();
  });
});

