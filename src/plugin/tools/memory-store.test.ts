import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryStoreTool } from "./memory-store.js";

const { resolveScopeMock, memoryStoreDbMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  memoryStoreDbMock: vi.fn(),
}));

vi.mock("../../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("../../memory/store.js", () => ({
  memoryStoreDb: memoryStoreDbMock,
}));

function buildCtx() {
  const registerTool = vi.fn();
  return {
    ctx: {
      api: {
        registerTool,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: { agentId: "main", sessionKey: "agent:main:main" },
      },
      disabledReason: null,
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
      cfg: { workspaceDir: "/workspace" },
      resolveActor: vi.fn(() => "tester"),
    } as any,
    registerTool,
  };
}

describe("memory_store visible output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns compact JSON envelope in content on success", async () => {
    (memoryStoreDbMock as any).mockResolvedValueOnce({
      ok: true,
      id: "11111111-1111-1111-1111-111111111111",
      path: "db-memory/items/11111111-1111-1111-1111-111111111111.md",
      canonicalKey: "preferred_language",
      type: "fact",
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryStoreTool({
      ctx,
      refreshPromptCache: vi.fn(),
    } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-1", {
      content: "I prefer TypeScript.",
      canonicalKey: "preferred_language",
      type: "fact",
    });

    const visible = JSON.parse(result.content[0].text);
    expect(visible).toMatchObject({
      ok: true,
      path: "db-memory/items/11111111-1111-1111-1111-111111111111.md",
      id: "11111111-1111-1111-1111-111111111111",
      canonicalKey: "preferred_language",
      type: "fact",
    });
  });
});
