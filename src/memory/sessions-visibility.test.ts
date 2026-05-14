import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  extractIdentity,
  loadStore,
  resolveKeys,
  resolveEffectiveVisibility,
  createA2aPolicy,
  createGuard,
} = vi.hoisted(() => ({
  extractIdentity: vi.fn(),
  loadStore: vi.fn(),
  resolveKeys: vi.fn(),
  resolveEffectiveVisibility: vi.fn(() => "all"),
  createA2aPolicy: vi.fn(() => ({})),
  createGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/session-transcript-hit", () => ({
  extractTranscriptIdentityFromSessionsMemoryHit: extractIdentity,
  loadCombinedSessionStoreForGateway: loadStore,
  resolveTranscriptStemToSessionKeys: resolveKeys,
}));

vi.mock("openclaw/plugin-sdk/session-visibility", () => ({
  resolveEffectiveSessionToolsVisibility: resolveEffectiveVisibility,
  createAgentToAgentPolicy: createA2aPolicy,
  createSessionVisibilityGuard: createGuard,
}));

import { canAccessSessionPathByVisibility, filterSessionHitsByVisibility } from "./sessions-visibility.js";

function buildApi() {
  return {
    runtime: {
      sessionKey: "agent:main:main",
      config: {
        current: () => ({ tools: { sessions: { visibility: "all" } } }),
      },
    },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  loadStore.mockReturnValue({ store: { "agent:main:main": { sessionId: "s1" } } });
  extractIdentity.mockReturnValue({ stem: "s1", archived: false });
  resolveKeys.mockReturnValue(["agent:main:main"]);
  createGuard.mockResolvedValue({
    check: vi.fn(() => ({ allowed: true })),
  });
});

describe("filterSessionHitsByVisibility", () => {
  it("passes runtime sandboxed flag into effective visibility resolver", async () => {
    const api = buildApi();
    (api as any).runtime.sandboxed = true;
    const hits = [{ corpus: "sessions", path: "sessions/main/s1.jsonl", score: 0.5 }];
    await filterSessionHitsByVisibility({ api, hits });
    expect(resolveEffectiveVisibility).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxed: true,
      }),
    );
  });

  it("keeps memory hits and allows sessions hits approved by guard", async () => {
    const api = buildApi();
    const hits = [
      { corpus: "memory", path: "db-memory/items/1.md", score: 1 },
      { corpus: "sessions", path: "sessions/main/s1.jsonl", score: 0.5 },
    ];
    const filtered = await filterSessionHitsByVisibility({ api, hits });
    expect(filtered).toHaveLength(2);
    expect(filtered[1]?.path).toBe("sessions/main/s1.jsonl");
  });

  it("drops sessions hits denied by guard", async () => {
    const api = buildApi();
    createGuard.mockResolvedValue({
      check: vi.fn(() => ({ allowed: false, error: "forbidden" })),
    });
    const hits = [{ corpus: "sessions", path: "sessions/other/s2.jsonl", score: 0.5 }];
    const filtered = await filterSessionHitsByVisibility({ api, hits });
    expect(filtered).toHaveLength(0);
  });

  it("drops sessions hits when requester session key is missing", async () => {
    const api = buildApi();
    delete (api as any).runtime.sessionKey;
    const hits = [{ corpus: "sessions", path: "sessions/main/s1.jsonl", score: 0.5 }];
    const filtered = await filterSessionHitsByVisibility({ api, hits });
    expect(filtered).toHaveLength(0);
  });

  it("drops sessions hits when transcript identity cannot be extracted", async () => {
    const api = buildApi();
    extractIdentity.mockReturnValueOnce(null);
    const hits = [{ corpus: "sessions", path: "sessions/main/not-a-transcript", score: 0.5 }];
    const filtered = await filterSessionHitsByVisibility({ api, hits });
    expect(filtered).toHaveLength(0);
  });
});

describe("canAccessSessionPathByVisibility", () => {
  it("returns allowed=true when any resolved key is allowed", async () => {
    const api = buildApi();
    createGuard.mockResolvedValue({
      check: vi.fn((key: string) =>
        key === "agent:main:main" ? { allowed: true } : { allowed: false, error: "forbidden" },
      ),
    });
    resolveKeys.mockReturnValue(["agent:other:main", "agent:main:main"]);
    const verdict = await canAccessSessionPathByVisibility({
      api,
      path: "sessions/main/s1.jsonl",
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("returns deny reason when all keys are blocked", async () => {
    const api = buildApi();
    createGuard.mockResolvedValue({
      check: vi.fn(() => ({ allowed: false, error: "blocked by visibility policy" })),
    });
    resolveKeys.mockReturnValue(["agent:other:main"]);
    const verdict = await canAccessSessionPathByVisibility({
      api,
      path: "sessions/other/s1.jsonl",
    });
    expect(verdict).toEqual({
      allowed: false,
      reason: "blocked by visibility policy",
    });
  });

  it("returns deny reason when transcript is not mapped to session keys", async () => {
    const api = buildApi();
    resolveKeys.mockReturnValueOnce([]);
    const verdict = await canAccessSessionPathByVisibility({
      api,
      path: "sessions/main/s1.jsonl",
    });
    expect(verdict).toEqual({
      allowed: false,
      reason: "session transcript is not mapped to known session keys",
    });
  });

  it("returns guard-unavailable when requester session key is missing", async () => {
    const api = buildApi();
    delete (api as any).runtime.sessionKey;
    const verdict = await canAccessSessionPathByVisibility({
      api,
      path: "sessions/main/s1.jsonl",
    });
    expect(verdict).toEqual({
      allowed: false,
      reason: "session visibility guard unavailable for current requester",
    });
  });
});
