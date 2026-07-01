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
  expect(opts).toEqual({ name: "memory_store" });
  expect(factory).toBeTypeOf("function");
  return factory(buildToolContext(overrides));
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
    const invalidatePromptMemory = vi.fn();
    registerMemoryStoreTool({
      ctx,
      invalidatePromptMemory,
    } as any);
    const def = materializeRegisteredTool(registerTool);
    expect(def.description).toContain("recurring schedules");
    expect(def.description).toContain("DB-backed implementation for curated MEMORY.md writes");
    expect(def.description).toContain("Use for save requests about stable facts");
    expect(def.description).toContain("Use memory_log for daily/current context");
    expect(def.description).toContain("Do not confirm saved until this tool succeeds.");
    expect(def.description).not.toContain("запомни");

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
    expect(invalidatePromptMemory).toHaveBeenCalledWith({ workspaceDir: "/runtime/workspace" });
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/workspace",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
    expect(memoryStoreDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        semantic: expect.objectContaining({
          agentId: "main",
        }),
      }),
    );
  });

  it("waits for lazy startup bootstrap when durable state is still pending", async () => {
    (memoryStoreDbMock as any).mockResolvedValueOnce({
      ok: true,
      id: "22222222-2222-2222-2222-222222222222",
      path: "db-memory/items/22222222-2222-2222-2222-222222222222.md",
      canonicalKey: null,
      type: "note",
    });
    const { ctx, registerTool } = buildCtx();
    ctx.durableState = { overall: "pending", reason: null };
    const ensureStartupBootstrap = vi.fn(async () => {
      ctx.durableState = { overall: "ready", reason: null };
    });
    registerMemoryStoreTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
      ensureStartupBootstrap,
    } as any);
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-pending-1", {
      content: "Pending startup should bootstrap lazily.",
    });

    expect(ensureStartupBootstrap).toHaveBeenCalledTimes(1);
    expect(result.details.ok).toBe(true);
    expect(memoryStoreDbMock).toHaveBeenCalledTimes(1);
  });

  it("uses tool context workspace and agent instead of global runtime agent", async () => {
    (memoryStoreDbMock as any).mockResolvedValueOnce({
      ok: true,
      id: "33333333-3333-3333-3333-333333333333",
      path: "db-memory/items/33333333-3333-3333-3333-333333333333.md",
      canonicalKey: null,
      type: "note",
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryStoreTool({
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
      content: "Ops durable note.",
    });

    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      }),
    );
    expect(memoryStoreDbMock).toHaveBeenCalledTimes(1);
    expect(memoryStoreDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        semantic: expect.objectContaining({
          agentId: "ops",
        }),
      }),
    );
  });
});
