import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveScope,
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
  isSessionFileForAgent,
  sessionPathForFile,
  statMock,
} = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  syncSessionsIndexDb: vi.fn(async () => ({
    indexedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    removedFiles: 0,
  })),
  syncVisibleSessionsIndexDb: vi.fn(async () => ({
    indexedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    removedFiles: 0,
  })),
  isSessionFileForAgent: vi.fn(async () => true),
  sessionPathForFile: vi.fn((sessionFile: string) => {
    const normalized = sessionFile.replaceAll("\\", "/");
    const fileName = normalized.split("/").pop() ?? "session.jsonl";
    return `sessions/main/${fileName}`;
  }),
  statMock: vi.fn(async () => ({ size: 128 })),
}));

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

vi.mock("../memory/sessions-index-sync.js", () => ({
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
}));

vi.mock("../memory/sessions.js", () => ({
  isSessionFileForAgent,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-qmd")>();
  return {
    ...actual,
    sessionPathForFile,
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    stat: statMock,
  },
}));

import { createSessionDeltaRuntime } from "./session-delta.js";

function buildRuntime(params?: {
  visibility?: "current" | "visible";
  agents?: Array<{ id: string; default?: boolean; workspace: string }>;
  deltaBytes?: number;
  deltaMessages?: number;
}) {
  const agents = params?.agents ?? [
    { id: "main", default: true, workspace: "/work/main" },
    { id: "ops", workspace: "/work/ops" },
  ];
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/work/main",
      config: {
        current: () => ({ agents: { list: agents } }),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn((handler: (update: unknown) => void) => {
          api.__sessionTranscriptHandler = handler;
          return vi.fn();
        }),
      },
    },
  } as any;
  const ctx = {
    cfg: {
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: {
        search: { enabled: true },
        visibility: params?.visibility ?? "current",
        sync: {
          deltaBytes: params?.deltaBytes ?? 100_000,
          deltaMessages: params?.deltaMessages ?? 50,
        },
      },
    },
    sessionsIndex: {
      bootstrapPromises: new Map(),
      bootstrappedKeys: new Set(),
    },
    sessionDelta: {
      pendingByPath: new Map(),
      retryAttemptsByTarget: new Map(),
      timer: null,
      syncInFlight: null,
      unsubscribe: null,
      closed: false,
      ignoredPathCounts: new Map(),
      stateByPath: new Map(),
    },
    ensureReady: vi.fn(async () => undefined),
    getPool: vi.fn(() => ({ query: vi.fn() })),
    listVisibleAgentIds: vi.fn(async (agentId: string) => {
      const workspace = agents.find((agent) => agent.id === agentId)?.workspace;
      return agents.filter((agent) => agent.workspace === workspace).map((agent) => agent.id);
    }),
  } as any;
  return {
    api,
    ctx,
    runtime: createSessionDeltaRuntime({ api, ctx }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  resolveScope.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
    userId: "user-1",
    workspaceId: `workspace:${workspaceDir}`,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session index bootstrap scope", () => {
  it("bootstraps separate agent workspaces independently and dedupes repeat calls", async () => {
    const { runtime } = buildRuntime();

    await runtime.ensureSessionsIndexBootstrapped({
      workspaceDir: "/work/main",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    await runtime.ensureSessionsIndexBootstrapped({
      workspaceDir: "/work/ops",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
    await runtime.ensureSessionsIndexBootstrapped({
      workspaceDir: "/work/main",
      agentId: "main",
      sessionKey: "agent:main:other",
    });

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(2);
    expect(syncSessionsIndexDb).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: "workspace:/work/main",
        agentId: "main",
      }),
    );
    expect(syncSessionsIndexDb).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceId: "workspace:/work/ops",
        agentId: "ops",
      }),
    );
  });

  it("dedupes visible bootstrap for agents sharing one workspace", async () => {
    const { runtime } = buildRuntime({
      visibility: "visible",
      agents: [
        { id: "main", default: true, workspace: "/work/shared" },
        { id: "ops", workspace: "/work/shared" },
      ],
    });

    await runtime.ensureSessionsIndexBootstrapped({
      workspaceDir: "/work/shared",
      agentId: "main",
    });
    await runtime.ensureSessionsIndexBootstrapped({
      workspaceDir: "/work/shared",
      agentId: "ops",
    });

    expect(syncVisibleSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncVisibleSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace:/work/shared",
        agentId: "main",
        otherAgentIds: ["ops"],
      }),
    );
  });
});

describe("session delta retry", () => {
  it("requeues a failed target and retries it without a new transcript event", async () => {
    syncSessionsIndexDb
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        indexedFiles: 1,
        updatedFiles: 0,
        skippedFiles: 0,
        removedFiles: 0,
      });
    const { api, ctx, runtime } = buildRuntime({
      deltaBytes: 1,
      deltaMessages: 0,
    });

    runtime.ensureSessionDeltaListener();
    const handler = api.__sessionTranscriptHandler as ((update: unknown) => void) | undefined;
    expect(typeof handler).toBe("function");

    handler?.({
      sessionFile: "/tmp/sessions/main/turn-1.jsonl",
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(ctx.sessionDelta.pendingByPath.size).toBe(1);
    expect(ctx.sessionDelta.retryAttemptsByTarget.get("/work/main\u0000main")).toBe(1);
    expect(ctx.sessionDelta.timer).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(2);
    expect(ctx.sessionDelta.pendingByPath.size).toBe(0);
    expect(ctx.sessionDelta.retryAttemptsByTarget.size).toBe(0);
    expect(ctx.sessionDelta.timer).toBeNull();
  });
});
