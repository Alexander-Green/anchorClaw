import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryForgetTool } from "./memory-forget.js";

const { resolveScopeMock, memoryForgetDbMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  memoryForgetDbMock: vi.fn(),
}));

vi.mock("../../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("../../memory/forget.js", () => ({
  memoryForgetDb: memoryForgetDbMock,
}));

function buildCtx() {
  const registerTool = vi.fn();
  return {
    ctx: {
      api: {
        registerTool,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        runtime: {
          agentId: "main",
          sessionKey: "agent:main:main",
          config: {
            current: () => ({
              agents: {
                list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
              },
            }),
          },
        },
      },
      disabledReason: null,
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn() })),
      cfg: { workspaceDir: "/legacy-workspace" },
      resolveActor: vi.fn(() => "tester"),
    } as any,
    registerTool,
  };
}

describe("memory_forget visible output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns compact JSON envelope in content on success", async () => {
    (memoryForgetDbMock as any).mockResolvedValueOnce({
      ok: true,
      deleted: 1,
    });
    const { ctx, registerTool } = buildCtx();
    const refreshPromptCache = vi.fn(async () => undefined);
    registerMemoryForgetTool({
      ctx,
      refreshPromptCache,
    } as any);
    const def = registerTool.mock.calls[0]?.[0];

    const result = await def.execute("toolcall-1", {
      lookup: "db-memory/items/11111111-1111-1111-1111-111111111111.md",
    });

    const visible = JSON.parse(result.content[0].text);
    expect(visible).toMatchObject({
      ok: true,
      deleted: 1,
      lookup: "db-memory/items/11111111-1111-1111-1111-111111111111.md",
      id: null,
    });
    expect(refreshPromptCache).toHaveBeenCalledWith({ force: true });
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/workspace",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });
});
