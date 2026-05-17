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

  it("uses narrow one-exact-value guidance for marker/id/key questions", () => {
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

    expect(text).toContain("For one exact marker/id/key value questions");
    expect(text).toContain("prioritize literal evidence from memory_search/memory_recall");
    expect(text).toContain("If any memory_search or memory_recall result has details.meta.exactTop1=true");
    expect(text).toContain("Never use empty memory_recall as a tie-breaker for exact lookups.");
    expect(text).toContain("If no exactTop1 is found, say you checked and give the best candidate with uncertainty.");
    expect(text).not.toContain("For exact marker/id/key questions");
    expect(text).not.toContain("make at most two memory_search/memory_recall attempts");
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

    expect(text).toContain("Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search; then use memory_get to pull only the needed lines.");
    expect(text).toContain("If no exactTop1 is found, say you checked and give the best candidate with uncertainty.");
    expect(text).toContain("For broad agreement/policy/decision questions, use memory_search/memory_recall to gather closest evidence");
    expect(text).toContain("if no direct agreement record is found, report not found with a brief summary of closest evidence.");
    expect(text).not.toContain("cap retrieval at two memory_search queries plus at most one memory_recall fallback");
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
});
