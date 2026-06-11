import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMemoryLogTool } from "./memory-log.js";

const { resolveScopeMock, appendDailyEntryDbMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(async () => ({ userId: "u1", workspaceId: "w1" })),
  appendDailyEntryDbMock: vi.fn(),
}));

vi.mock("../../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("../../memory/daily.js", async () => {
  const actual = await vi.importActual<typeof import("../../memory/daily.js")>("../../memory/daily.js");
  return {
    ...actual,
    appendDailyEntryDb: appendDailyEntryDbMock,
  };
});

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
              plugins: { slots: { memory: "anchorclaw" } },
              agents: {
                list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
                defaults: { userTimezone: "America/Chicago" },
              },
            }),
          },
        },
      },
      disabledReason: null,
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn() })),
      cfg: {},
      resolveActor: vi.fn(() => "tester"),
      durableState: { overall: "ready" },
    } as any,
    registerTool,
  };
}

function buildToolContext(overrides?: Record<string, unknown>) {
  return {
    runtimeConfig: {
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
        defaults: { userTimezone: "America/Chicago" },
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
  expect(opts).toEqual({ name: "memory_log" });
  expect(factory).toBeTypeOf("function");
  return factory(buildToolContext(overrides));
}

describe("memory_log tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns compact JSON envelope in content on success", async () => {
    (appendDailyEntryDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "daily",
      id: "11111111-1111-1111-1111-111111111111",
      path: "memory/2026-05-20.md",
      logicalDate: "2026-05-20",
      created: true,
      updatedAt: "2026-05-20T12:00:00.000Z",
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryLogTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
    } as any);
    const def = materializeRegisteredTool(registerTool);
    expect(def.description).toContain("DB-backed implementation for memory/YYYY-MM-DD.md appends");
    expect(def.description).toContain("Use for save requests about today, now, current conversation");
    expect(def.description).toContain("Use memory_store for durable facts, preferences, schedules");
    expect(def.description).toContain("Do not confirm logged until this tool succeeds.");

    const result = await def.execute("toolcall-1", {
      content: "Today we confirmed daily DB ownership.",
      date: "2026-05-20",
    });

    const visible = JSON.parse(result.content[0].text);
    expect(visible).toMatchObject({
      ok: true,
      path: "memory/2026-05-20.md",
      id: "11111111-1111-1111-1111-111111111111",
      logicalDate: "2026-05-20",
      created: true,
    });
    expect(appendDailyEntryDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalDate: "2026-05-20",
        sourceKind: "memory_log",
      }),
    );
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/workspace",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("accepts OpenClaw-style daily path alias", async () => {
    (appendDailyEntryDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "daily",
      id: "11111111-1111-1111-1111-111111111111",
      path: "memory/2026-05-21.md",
      logicalDate: "2026-05-21",
      created: false,
      updatedAt: "2026-05-21T12:00:00.000Z",
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryLogTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
    } as any);
    const def = materializeRegisteredTool(registerTool);

    await def.execute("toolcall-2", {
      content: "Daily alias path write.",
      path: "memory/2026-05-21.md",
    });

    expect(appendDailyEntryDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalDate: "2026-05-21",
      }),
    );
  });

  it("uses tool context workspace and agent instead of global runtime agent", async () => {
    (appendDailyEntryDbMock as any).mockResolvedValueOnce({
      ok: true,
      corpus: "daily",
      id: "22222222-2222-2222-2222-222222222222",
      path: "memory/2026-05-22.md",
      logicalDate: "2026-05-22",
      created: true,
      updatedAt: "2026-05-22T12:00:00.000Z",
    });
    const { ctx, registerTool } = buildCtx();
    registerMemoryLogTool({
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
          defaults: { userTimezone: "America/Chicago" },
        },
      },
      workspaceDir: "/runtime/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });

    await def.execute("toolcall-ops-1", {
      content: "Ops daily note.",
      date: "2026-05-22",
    });

    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/runtime/ops",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      }),
    );
    expect(appendDailyEntryDbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          runtimeAgentId: "ops",
          sessionKey: "agent:ops:main",
        }),
      }),
    );
  });

  it("rejects invalid daily path alias", async () => {
    const { ctx, registerTool } = buildCtx();
    registerMemoryLogTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
    } as any);
    const def = materializeRegisteredTool(registerTool);

    const result = await def.execute("toolcall-3", {
      content: "Bad path",
      path: "memory/today.md",
    });

    expect(result.details).toMatchObject({
      disabled: true,
      error: "invalid daily path",
    });
    expect(appendDailyEntryDbMock).not.toHaveBeenCalled();
  });

  it("does not fall back to a removed global workspace when runtime config is unavailable", async () => {
    const { ctx, registerTool } = buildCtx();
    (ctx.api.runtime as any).config = undefined;

    registerMemoryLogTool({
      ctx,
      invalidatePromptMemory: vi.fn(),
    } as any);
    const def = materializeRegisteredTool(registerTool, {
      runtimeConfig: undefined,
      getRuntimeConfig: undefined,
      workspaceDir: undefined,
      agentId: undefined,
      sessionKey: undefined,
    });

    const result = await def.execute("toolcall-4", {
      content: "No runtime config",
    });

    expect(result.details).toMatchObject({
      disabled: true,
      error: "runtime_workspace_unavailable",
    });
    expect(resolveScopeMock).not.toHaveBeenCalled();
    expect(appendDailyEntryDbMock).not.toHaveBeenCalled();
  });
});
