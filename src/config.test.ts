import { describe, expect, it } from "vitest";
import {
  anchorClawConfigSchema,
  resolveAgentMemorySearchConfig,
  resolveSemanticLayerState,
} from "./config.js";

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

describe("anchorClawConfigSchema workspaceDir", () => {
  it("rejects removed workspaceDir", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        workspaceDir: "/workspace",
      }),
    ).toThrow(
      "workspaceDir was removed in AnchorClaw 0.0.9 because workspace routing now follows the OpenClaw multi-agent model. See ARCHITECTURE.md#multi-agent-workspace-model",
    );
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

describe("anchorClawConfigSchema semantic", () => {
  it("treats omitted semantic config as disabled", () => {
    const parsed = anchorClawConfigSchema.parse(baseConfig());
    expect(parsed.semantic).toBeUndefined();
    expect(resolveSemanticLayerState(parsed)).toEqual({
      configured: false,
      enabled: false,
      effective: false,
      reason: "semantic_disabled",
    });
  });

  it("accepts semantic.enabled=true as the semantic layer opt-in", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      semantic: {
        enabled: true,
      },
    });
    expect(parsed.semantic?.enabled).toBe(true);
    expect(resolveSemanticLayerState(parsed)).toEqual({
      configured: true,
      enabled: true,
      effective: true,
      reason: null,
    });
  });

  it("rejects non-boolean semantic.enabled", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        semantic: {
          enabled: "yes" as any,
        },
      }),
    ).toThrow("semantic.enabled must be a boolean");
  });

  it("rejects unknown semantic keys", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        semantic: {
          enabled: false,
          provider: "openclaw-memorySearch",
        },
      }),
    ).toThrow("semantic has unknown keys: provider");
  });
});

describe("resolveAgentMemorySearchConfig", () => {
  it("prefers per-agent memorySearch over defaults", () => {
    expect(
      resolveAgentMemorySearchConfig({
        runtimeConfig: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai",
                model: "text-embedding-3-small",
                remote: { baseUrl: "https://defaults.example", apiKey: "${DEFAULTS_KEY}" },
              },
            },
            list: [
              {
                id: "main",
                memorySearch: {
                  provider: "ollama",
                  model: "nomic-embed-text",
                  remote: { baseUrl: "http://127.0.0.1:11434", apiKey: "${OLLAMA_KEY}" },
                },
              },
            ],
          },
        },
        agentId: "main",
      }),
    ).toEqual({
      configured: true,
      source: "agent",
      provider: "ollama",
      model: "nomic-embed-text",
      baseUrl: "http://127.0.0.1:11434",
      apiKeyConfigured: true,
    });
  });

  it("falls back to defaults when agent has no memorySearch", () => {
    expect(
      resolveAgentMemorySearchConfig({
        runtimeConfig: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai",
                model: "text-embedding-3-small",
                remote: { baseUrl: "https://defaults.example" },
              },
            },
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
      }),
    ).toEqual({
      configured: true,
      source: "defaults",
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://defaults.example",
      apiKeyConfigured: false,
    });
  });

  it("reports unconfigured when neither agent nor defaults define memorySearch", () => {
    expect(
      resolveAgentMemorySearchConfig({
        runtimeConfig: {
          agents: {
            list: [{ id: "main" }],
          },
        },
        agentId: "main",
      }),
    ).toEqual({
      configured: false,
      source: null,
      apiKeyConfigured: false,
    });
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
    expect(parsed.maintenance?.extractor?.maxCandidates).toBe(10);
    expect(parsed.maintenance?.extractor?.maxCharsPerRun).toBe(12_000);
    expect(parsed.maintenance?.workspaceScope).toBeUndefined();
  });

  it("accepts custom maintenance settings", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      maintenance: {
        enabled: true,
        dryRun: false,
        intervalMinutes: 15,
        batchSize: 500,
        workspaceScope: {
          mode: "default-agent",
        },
        extractor: {
          enabled: true,
          maxCandidates: 8,
          maxCharsPerRun: 20000,
        },
      },
    });
    expect(parsed.maintenance?.enabled).toBe(true);
    expect(parsed.maintenance?.dryRun).toBe(false);
    expect(parsed.maintenance?.intervalMinutes).toBe(15);
    expect(parsed.maintenance?.batchSize).toBe(500);
    expect(parsed.maintenance?.workspaceScope).toEqual({ mode: "default-agent" });
    expect(parsed.maintenance?.extractor?.enabled).toBe(true);
    expect(parsed.maintenance?.extractor?.maxCandidates).toBe(8);
    expect(parsed.maintenance?.extractor?.maxCharsPerRun).toBe(20000);
  });

  it("rejects removed maintenance.extractor.agentId", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        maintenance: {
          extractor: {
            enabled: true,
            agentId: "worker-a",
          },
        },
      }),
    ).toThrow(
      "maintenance.extractor.agentId was removed in AnchorClaw 0.0.9 because workspace routing now follows the OpenClaw multi-agent model. See ARCHITECTURE.md#multi-agent-workspace-model",
    );
  });

  it("accepts maintenance workspaceScope mode=agents", () => {
    const parsed = anchorClawConfigSchema.parse({
      ...baseConfig(),
      maintenance: {
        workspaceScope: {
          mode: "agents",
          agents: ["main", "ops"],
        },
      },
    });
    expect(parsed.maintenance?.workspaceScope).toEqual({
      mode: "agents",
      agents: ["main", "ops"],
    });
  });

  it("rejects maintenance workspaceScope agents outside mode=agents", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        maintenance: {
          workspaceScope: {
            mode: "default-agent",
            agents: ["main"],
          },
        },
      }),
    ).toThrow("maintenance.workspaceScope.agents is only allowed when mode=agents");
  });

  it("rejects maintenance workspaceScope mode=agents without agent list", () => {
    expect(() =>
      anchorClawConfigSchema.parse({
        ...baseConfig(),
        maintenance: {
          workspaceScope: {
            mode: "agents",
          },
        },
      }),
    ).toThrow("maintenance.workspaceScope.agents must be an array");
  });
});
