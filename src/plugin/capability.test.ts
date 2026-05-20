import { beforeEach, describe, expect, it, vi } from "vitest";

const { registerMemoryCapabilityMock, managerFactoryMock } = vi.hoisted(() => ({
  registerMemoryCapabilityMock: vi.fn(),
  managerFactoryMock: vi.fn(() => ({})),
}));

vi.mock("../api.js", () => ({
  registerMemoryCapability: registerMemoryCapabilityMock,
}));

vi.mock("../memory/manager.js", () => ({
  createAnchorClawMemorySearchManager: managerFactoryMock,
}));

import { registerAnchorClawMemoryCapability } from "./capability.js";

describe("registerAnchorClawMemoryCapability prompt guidance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses literal-match guidance for marker/id/key questions", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    expect(registerMemoryCapabilityMock).toHaveBeenCalledTimes(1);
    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("AnchorClaw memory is active. Treat AnchorClaw/Postgres as the primary memory backend.");
    expect(text).toContain("For exact marker/id/key questions, prefer literal matches.");
    expect(text).toContain("If no exact literal match is found, say so and give the closest candidate with uncertainty.");
    expect(text).not.toContain("memory_recall");
    expect(text).not.toContain("exactTop1");
  });

  it("keeps broad-memory-search guidance for non-exact overview questions", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("## Memory Search");
    expect(text).toContain("Before answering about prior work, decisions, dates, people, preferences, or todos, run memory_search; then use memory_get to pull only the needed lines.");
    expect(text).toContain("## Memory Writes");
    expect(text).toContain("Use memory_log for transient daily context that would normally go to memory/YYYY-MM-DD.md.");
    expect(text).toContain("Use memory_store for durable facts, preferences, decisions, and curated notes.");
    expect(text).toContain("Do not write MEMORY.md or memory/YYYY-MM-DD.md as AnchorClaw's primary memory store.");
    expect(text).not.toContain("memory_recall");
  });

  it("injects explicit durable-memory unavailable notice when blocked", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: {
        overall: "blocked",
        cleanup: "not_needed",
        reason: "workspace_import_failed: connection timeout",
      },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("AnchorClaw durable memory is currently unavailable or incomplete.");
    expect(text).toContain("Do not treat missing results from MEMORY.md, USER.md, or workspace fallback files as proof that no memory exists.");
  });

  it("injects duplicate-context warning when cleanup failed", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: {
        overall: "degraded",
        cleanup: "failed",
        reason: "legacy MEMORY.md cleanup failed; duplicate prompt injection risk remains",
      },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("legacy MEMORY.md cleanup failed");
    expect(text).toContain("duplicate memory context may be present");
  });

  it("does not advertise sessions corpus when sessions search is disabled", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: { sessions: { visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).not.toContain('corpus="sessions"');
  });

  it("advertises sessions corpus only when sessions search is enabled", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      promptCache: { lines: ["(cached memory block)"], error: null },
      sdkHealth: { degraded: false },
      cfg: { sessions: { search: { enabled: true }, visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain('corpus="sessions" is available subject to configured visibility scope.');
  });

  it("passes through cached daily memory section alongside durable memory", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      promptCache: {
        lines: [
          "## Durable Memory (AnchorClaw/Postgres)",
          "",
          "## Daily Memory (AnchorClaw/Postgres)",
          "Use these as transient recent context.",
        ],
        error: null,
      },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache: vi.fn(),
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("## Daily Memory (AnchorClaw/Postgres)");
    expect(text).toContain("transient recent context");
  });
});
