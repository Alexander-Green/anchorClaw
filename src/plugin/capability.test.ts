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
    expect(text).toContain("make at most two memory_search/memory_recall attempts");
    expect(text).toContain("If any memory_search or memory_recall result has details.meta.exactTop1=true");
    expect(text).toContain("Never use empty memory_recall as a tie-breaker for exact lookups.");
    expect(text).not.toContain("For exact marker/id/key questions");
  });

  it("keeps broad-memory-search guidance for non-exact overview questions", () => {
    const ctx = {
      api: {},
      disabledReason: null,
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
    expect(text).toContain("If no exactTop1 after two attempts, say you checked and give the best candidate with uncertainty.");
  });
});
