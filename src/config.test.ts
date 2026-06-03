import { describe, expect, it } from "vitest";
import { anchorClawConfigSchema } from "./config.js";

function baseConfig(): Record<string, unknown> {
  return {
    workspaceDir: "/workspace",
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

describe("anchorClawConfigSchema workspaceDir", () => {
  it("requires workspaceDir", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      }),
    ).toThrow("workspaceDir required");
  });

  it("accepts env substitution for workspaceDir", () => {
    const previous = process.env.ANCHORCLAW_TEST_WORKSPACE_DIR;
    try {
      process.env.ANCHORCLAW_TEST_WORKSPACE_DIR = "/workspace/from-env";
      const parsed = anchorClawConfigSchema.parse({
        ...baseConfig(),
        workspaceDir: "${ANCHORCLAW_TEST_WORKSPACE_DIR}",
      });
      expect(parsed.workspaceDir).toBe("/workspace/from-env");
    } finally {
      if (previous === undefined) {
        delete process.env.ANCHORCLAW_TEST_WORKSPACE_DIR;
      } else {
        process.env.ANCHORCLAW_TEST_WORKSPACE_DIR = previous;
      }
    }
  });

  it("rejects blank workspaceDir when explicitly configured", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        workspaceDir: "   ",
      }),
    ).toThrow("workspaceDir required");
  });
});

describe("anchorClawConfigSchema debug", () => {
  it("accepts debug.promptLogEnabled", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      debug: {
        promptLogEnabled: true,
      },
    });
    expect(parsed.debug?.promptLogEnabled).toBe(true);
  });

  it("rejects non-boolean debug.promptLogEnabled", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        debug: {
          promptLogEnabled: "yes" as any,
        },
      }),
    ).toThrow("debug.promptLogEnabled must be a boolean");
  });
});

describe("anchorClawConfigSchema sessions.visibility", () => {
  it("defaults to sessions.search.enabled=false and sessions.visibility=current when sessions block is omitted", () => {
    const parsed = anchorClawConfigSchema.parse(baseConfig());
    expect(parsed.sessions?.search?.enabled).toBe(false);
    expect(parsed.sessions?.visibility).toBe("current");
    expect(parsed.sessions?.sync?.deltaBytes).toBe(100_000);
    expect(parsed.sessions?.sync?.deltaMessages).toBe(50);
  });

  it("accepts sessions.search.enabled=true", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      sessions: {
        search: { enabled: true },
      },
    });
    expect(parsed.sessions?.search?.enabled).toBe(true);
    expect(parsed.sessions?.visibility).toBe("current");
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

  it("rejects non-boolean sessions.search.enabled", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        sessions: {
          search: { enabled: "yes" as any },
        },
      }),
    ).toThrow("sessions.search.enabled must be a boolean");
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

describe("anchorClawConfigSchema maintenance", () => {
  it("defaults maintenance config when block is omitted", () => {
    const parsed = anchorClawConfigSchema.parse(baseConfig());
    expect(parsed.maintenance?.enabled).toBe(false);
    expect(parsed.maintenance?.dryRun).toBe(true);
    expect(parsed.maintenance?.intervalMinutes).toBe(12 * 60);
    expect(parsed.maintenance?.batchSize).toBe(200);
    expect(parsed.maintenance?.extractor?.enabled).toBe(false);
    expect(parsed.maintenance?.extractor?.agentId).toBe("main");
    expect(parsed.maintenance?.extractor?.maxCandidates).toBe(20);
    expect(parsed.maintenance?.extractor?.maxCharsPerRun).toBe(12_000);
  });

  it("accepts custom maintenance settings", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      maintenance: {
        enabled: true,
        dryRun: false,
        intervalMinutes: 15,
        batchSize: 500,
        extractor: {
          enabled: true,
          agentId: "worker-a",
          maxCandidates: 8,
          maxCharsPerRun: 20000,
        },
      },
    });
    expect(parsed.maintenance?.enabled).toBe(true);
    expect(parsed.maintenance?.dryRun).toBe(false);
    expect(parsed.maintenance?.intervalMinutes).toBe(15);
    expect(parsed.maintenance?.batchSize).toBe(500);
    expect(parsed.maintenance?.extractor?.enabled).toBe(true);
    expect(parsed.maintenance?.extractor?.agentId).toBe("worker-a");
    expect(parsed.maintenance?.extractor?.maxCandidates).toBe(8);
    expect(parsed.maintenance?.extractor?.maxCharsPerRun).toBe(20000);
  });
});
