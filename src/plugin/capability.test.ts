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
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
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
    expect(text).toContain("Prefer literal matches for marker/id/key questions");
    expect(text).toContain("if no exact match exists, say so and give the closest candidate with uncertainty.");
    expect(text).not.toContain("memory_recall");
    expect(text).not.toContain("exactTop1");
  });

  it("keeps broad-memory-search guidance for non-exact overview questions", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).toContain("## Memory Search");
    expect(text).toContain("Use memory_search before memory-based answers and memory_get for returned paths or exact file-like lookups.");
    expect(text).toContain("## Memory Writes");
    expect(text).toContain("A save request means the user wants information preserved beyond this reply.");
    expect(text).toContain("Call exactly one write tool before final text");
    expect(text).toContain("memory_store for durable facts, preferences, recurring schedules, decisions, settings, project rules, and curated notes");
    expect(text).toContain("memory_log for today, now, current conversation, events, meeting notes, and temporary notes");
    expect(text).toContain("If a direct durable fact hit answers the question, answer with it plainly.");
    expect(text).toContain("make the content self-contained and explicit about the subject");
    expect(text).toContain("If lifetime is unclear, ask one brief clarification instead of writing.");
    expect(text).toContain("Never say saved, remembered, or recorded unless the write tool returned success.");
    expect(text).not.toContain("запомни");
    expect(text).not.toContain("If AGENTS.md or the user refers to MEMORY.md");
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
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
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
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
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
      sdkHealth: { degraded: false },
      cfg: { sessions: { visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
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
      sdkHealth: { degraded: false },
      cfg: { sessions: { search: { enabled: true }, visibility: "current" } },
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
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

  it("keeps workspace-specific memory out of the static capability prompt", () => {
    const ctx = {
      api: {},
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const lines: string[] = capabilityDef.promptBuilder({
      availableTools: new Set(["memory_search", "memory_get"]),
      citationsMode: "inline",
    });
    const text = lines.join("\n");

    expect(text).not.toContain("## Durable Memory (AnchorClaw/Postgres)");
    expect(text).not.toContain("## Daily Memory (AnchorClaw/Postgres)");
    expect(text).not.toContain("transient recent context");
  });

  it("registers a flushPlanResolver that targets the controlled flush inbox", () => {
    const ctx = {
      api: {
        runtime: {
          config: {
            current: () => ({
              agents: { defaults: { userTimezone: "Asia/Almaty" } },
            }),
          },
        },
      },
      disabledReason: null,
      durableState: { overall: "ready", cleanup: "not_needed" },
      sdkHealth: { degraded: false },
      cfg: {},
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
    } as any;

    registerAnchorClawMemoryCapability({
      ctx,
      ensureSessionsIndexBootstrapped: vi.fn(async () => undefined),
    });

    const capabilityDef = registerMemoryCapabilityMock.mock.calls[0]?.[1];
    const flushPlan = capabilityDef.flushPlanResolver({
      nowMs: Date.parse("2026-06-02T10:11:12.345Z"),
    });

    expect(flushPlan).toBeTruthy();
    expect(flushPlan.relativePath).toContain(".anchorclaw/flush-inbox/2026-06-02/");
    expect(flushPlan.relativePath).toMatch(/flush-2026-06-02T10-11-12-345Z-[0-9a-f-]{36}\.md$/u);
    expect(flushPlan.prompt).toContain("Pre-compaction memory flush.");
  });
});
