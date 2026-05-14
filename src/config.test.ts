import { describe, expect, it } from "vitest";
import { anchorClawConfigSchema } from "./config.js";

function baseConfig(): Record<string, unknown> {
  return {
    postgres: {
      host: "localhost",
      database: "anchorclaw",
      user: "postgres",
    },
  };
}

describe("anchorClawConfigSchema identity.externalId", () => {
  it("accepts valid externalId length 1..20", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      identity: { externalId: "family-main-01" },
    });
    expect(parsed.identity?.externalId).toBe("family-main-01");
  });

  it("rejects empty/whitespace externalId", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        identity: { externalId: "   " },
      }),
    ).toThrow("identity.externalId must be non-empty");
  });

  it("rejects externalId longer than 20 chars", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        identity: { externalId: "abcdefghijklmnopqrstuvwxyz" },
      }),
    ).toThrow("identity.externalId must be at most 20 characters");
  });
});

describe("anchorClawConfigSchema sessions.visibility", () => {
  it("defaults to sessions.visibility=current when sessions block is omitted", () => {
    const parsed = anchorClawConfigSchema.parse(baseConfig());
    expect(parsed.sessions?.visibility).toBe("current");
    expect(parsed.sessions?.sync?.deltaBytes).toBe(100_000);
    expect(parsed.sessions?.sync?.deltaMessages).toBe(50);
  });

  it("accepts visibility=current|off|visible", () => {
    const currentParsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      sessions: { visibility: "current" },
    });
    expect(currentParsed.sessions?.visibility).toBe("current");

    const offParsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      sessions: { visibility: "off" },
    });
    expect(offParsed.sessions?.visibility).toBe("off");

    const visibleParsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      sessions: { visibility: "visible" },
    });
    expect(visibleParsed.sessions?.visibility).toBe("visible");
  });

  it("rejects unsupported sessions.visibility values", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        sessions: { visibility: "all" },
      }),
    ).toThrow("sessions.visibility must be one of: current, off, visible");
  });
});

describe("anchorClawConfigSchema sessions.sync", () => {
  it("accepts custom deltaBytes/deltaMessages thresholds", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      sessions: {
        visibility: "current",
        sync: {
          deltaBytes: 321,
          deltaMessages: 7,
        },
      },
    });
    expect(parsed.sessions?.sync?.deltaBytes).toBe(321);
    expect(parsed.sessions?.sync?.deltaMessages).toBe(7);
  });

  it("rejects negative thresholds", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        sessions: {
          sync: {
            deltaBytes: -1,
          },
        },
      }),
    ).toThrow("sessions.sync.deltaBytes must be between 0 and");
  });

  it("rejects non-integer thresholds", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        sessions: {
          sync: {
            deltaMessages: 2.5,
          },
        },
      }),
    ).toThrow("sessions.sync.deltaMessages must be an integer");
  });
});

