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
              agents: { defaults: { userTimezone: "America/Chicago" } },
            }),
          },
        },
      },
      disabledReason: null,
      ensureReady: vi.fn(async () => undefined),
      getPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn() })),
      cfg: { workspaceDir: "/workspace" },
      resolveActor: vi.fn(() => "tester"),
      durableState: { overall: "ready" },
    } as any,
    registerTool,
  };
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
      refreshPromptCache: vi.fn(),
    } as any);
    const def = registerTool.mock.calls[0]?.[0];
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
      refreshPromptCache: vi.fn(),
    } as any);
    const def = registerTool.mock.calls[0]?.[0];

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

  it("rejects invalid daily path alias", async () => {
    const { ctx, registerTool } = buildCtx();
    registerMemoryLogTool({
      ctx,
      refreshPromptCache: vi.fn(),
    } as any);
    const def = registerTool.mock.calls[0]?.[0];

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
});
