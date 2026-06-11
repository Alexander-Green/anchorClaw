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
      cfg: {},
      resolveActor: vi.fn(() => "tester"),
    } as any,
    registerTool,
  };
}

function buildToolContext(overrides?: Record<string, unknown>) {
  return {
    runtimeConfig: {
      agents: {
        list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
      },
    },
    workspaceDir: "/runtime/workspace",
    agentId: "main",
    sessionKey: "agent:main:main",
    ...overrides,
  };
}

function materializeRegisteredTool(registerTool: ReturnType<typeof vi.fn>, overrides?: Record<string, unknown>) {
  const factory = registerTool.mock.calls[0]?.[0];
  const opts = registerTool.mock.calls[0]?.[1];
  expect(opts).toEqual({ name: "memory_forget" });
  expect(factory).toBeTypeOf("function");
  return factory(buildToolContext(overrides));
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
    const invalidatePromptMemory = vi.fn();
    registerMemoryForgetTool({
      ctx,
      invalidatePromptMemory,
    } as any);
    const def = materializeRegisteredTool(registerTool);

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
    expect(invalidatePromptMemory).toHaveBeenCalledWith({ workspaceDir: "/runtime/workspace" });
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/workspace",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("uses tool context workspace and agent instead of global runtime agent", async () => {
    (memoryForgetDbMock as any).mockResolvedValueOnce({
      ok: true,
      deleted: 1,
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryForgetTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
    } as any);
    const def = materializeRegisteredTool(registerTool, {
      runtimeConfig: {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/runtime/workspace" },
            { id: "ops", workspace: "/runtime/ops" },
          ],
        },
      },
      workspaceDir: "/runtime/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });

    await def.execute("toolcall-ops-1", {
      lookup: "db-memory/items/22222222-2222-2222-2222-222222222222.md",
    });

    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      }),
    );
  });
});
