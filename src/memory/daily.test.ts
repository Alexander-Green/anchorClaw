import { describe, expect, it } from "vitest";

import { buildStartupMemoryDateStamps } from "./daily.js";

describe("buildStartupMemoryDateStamps", () => {
  it("returns local today and yesterday when UTC day matches", () => {
    expect(
      buildStartupMemoryDateStamps({
        nowMs: Date.parse("2026-06-03T10:00:00.000Z"),
        timezone: "UTC",
      }),
    ).toEqual(["2026-06-03", "2026-06-02"]);
  });

  it("prepends UTC day when it is ahead of the local calendar day", () => {
    expect(
      buildStartupMemoryDateStamps({
        nowMs: Date.parse("2026-06-03T00:30:00.000Z"),
        timezone: "America/Los_Angeles",
      }),
    ).toEqual(["2026-06-03", "2026-06-02", "2026-06-01"]);
  });
});
