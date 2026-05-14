import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  registerMemoryCapability,
  definePluginEntry,
  parseCfg,
  resolveScope,
  applyMigrations,
  loadMigrations,
  createPool,
  queryPromptItems,
  buildPromptSection,
  syncSessionsIndexDb,
  runImport,
  getIdentityWarning,
  isSessionFileForAgent,
  isSessionFileForAnyKnownAgent,
  memoryGetFromDb,
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
} = vi.hoisted(() => ({
  registerMemoryCapability: vi.fn(),
  definePluginEntry: vi.fn((entry: unknown) => entry),
  parseCfg: vi.fn(),
  resolveScope: vi.fn(),
  applyMigrations: vi.fn(async () => ({ applied: [] as string[] })),
  loadMigrations: vi.fn(async () => []),
  createPool: vi.fn(),
  queryPromptItems: vi.fn(async () => []),
  buildPromptSection: vi.fn(() => [] as string[]),
  syncSessionsIndexDb: vi.fn(async () => ({
    indexedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    removedFiles: 0,
  })),
  runImport: vi.fn(async () => undefined),
  getIdentityWarning: vi.fn(() => null),
  isSessionFileForAgent: vi.fn(async () => true),
  isSessionFileForAnyKnownAgent: vi.fn(async () => true),
  memoryGetFromDb: vi.fn(),
  canAccessSessionPathByVisibility: vi.fn(async () => ({ allowed: true, reason: undefined as string | undefined })),
  filterSessionHitsByVisibility: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
}));

vi.mock("./api.js", () => ({
  definePluginEntry,
  registerMemoryCapability,
}));

vi.mock("./config.js", () => ({
  anchorClawConfigSchema: {
    parse: parseCfg,
  },
}));

vi.mock("./identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

vi.mock("./migrations.js", () => ({
  applyMigrations,
}));

vi.mock("./migrations-fs.js", () => ({
  loadBundledMigrationsFromDisk: loadMigrations,
}));

vi.mock("./postgres.js", () => ({
  createPostgresPool: createPool,
}));

vi.mock("./memory/limits.js", () => ({
  resolveMemoryLimits: () => ({ maxResults: 10, getDefaultLines: 120, getMaxChars: 12_000 }),
}));

vi.mock("./memory/get.js", () => ({ memoryGetFromDb }));
vi.mock("./memory/search.js", () => ({ memorySearchDb: vi.fn(async () => []) }));
vi.mock("./memory/store.js", () => ({ memoryStoreDb: vi.fn() }));
vi.mock("./memory/forget.js", () => ({ memoryForgetDb: vi.fn() }));
vi.mock("./memory/recall.js", () => ({ memoryRecallDb: vi.fn() }));

vi.mock("./memory/prompt.js", () => ({
  queryPromptMemoryItems: queryPromptItems,
  buildPromptMemorySection: buildPromptSection,
}));

vi.mock("./memory/sessions.js", () => ({
  listKnownAgentIds: vi.fn(async () => []),
  memorySearchSessions: vi.fn(async () => []),
  isSessionFileForAgent,
  isSessionFileForAnyKnownAgent,
}));

vi.mock("./memory/sessions-index.js", () => ({
  hasSessionsIndexRows: vi.fn(async () => false),
  memorySearchSessionsIndexDb: vi.fn(async () => []),
  normalizeSessionLookupPath: vi.fn((value: string) => value),
}));

vi.mock("./memory/sessions-index-sync.js", () => ({
  syncSessionsIndexDb,
}));

vi.mock("./memory/sessions-visibility.js", () => ({
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
}));

vi.mock("./memory/manager.js", () => ({
  createAnchorClawMemorySearchManager: vi.fn(),
}));

vi.mock("./importer.js", () => ({
  runOneTimeWorkspaceImport: runImport,
}));

vi.mock("./identity-policy.js", () => ({
  getIdentityStartupWarning: getIdentityWarning,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  listSessionFilesForAgent: vi.fn(async () => []),
  sessionPathForFile: vi.fn((value: string) => value),
}));

import plugin from "./index.js";

function buildApi() {
  let transcriptListener: ((update: { sessionFile?: unknown }) => void) | null = null;
  let lifecycleCleanup: (() => Promise<void> | void) | null = null;
  const unsub = vi.fn();
  const api = {
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/work",
      config: {
        current: () => ({ plugins: { slots: { memory: "anchorclaw" } } }),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn((listener: (update: { sessionFile?: unknown }) => void) => {
          transcriptListener = listener;
          return unsub;
        }),
      },
    },
    lifecycle: {
      registerRuntimeLifecycle: vi.fn((registration: { cleanup?: () => Promise<void> | void }) => {
        lifecycleCleanup = registration.cleanup ?? null;
      }),
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerHostedMediaResolver: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as any;

  return {
    api,
    getTranscriptListener: () => transcriptListener,
    runCleanup: async () => {
      if (lifecycleCleanup) {
        await lifecycleCleanup();
      }
    },
    unsub,
  };
}

function buildApiLegacyLifecycle() {
  let transcriptListener: ((update: { sessionFile?: unknown }) => void) | null = null;
  let lifecycleCleanup: (() => Promise<void> | void) | null = null;
  const unsub = vi.fn();
  const api = {
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      agentId: "main",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/work",
      config: {
        current: () => ({ plugins: { slots: { memory: "anchorclaw" } } }),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn((listener: (update: { sessionFile?: unknown }) => void) => {
          transcriptListener = listener;
          return unsub;
        }),
      },
    },
    registerRuntimeLifecycle: vi.fn((registration: { cleanup?: () => Promise<void> | void }) => {
      lifecycleCleanup = registration.cleanup ?? null;
    }),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerHostedMediaResolver: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as any;

  return {
    api,
    getTranscriptListener: () => transcriptListener,
    runCleanup: async () => {
      if (lifecycleCleanup) {
        await lifecycleCleanup();
      }
    },
    unsub,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  parseCfg.mockReturnValue({
    postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
    sessions: { visibility: "current" },
    identity: { externalId: "test" },
  });
  memoryGetFromDb.mockResolvedValue({
    ok: true,
    corpus: "sessions",
    path: "sessions/main/a.jsonl",
    kind: "session",
    content: "ok",
    fromLine: 1,
    lineCount: 1,
  });
  const pool = {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  };
  createPool.mockReturnValue(pool);
  resolveScope.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("phase2 session delta listener", () => {
  it("filters out non-current-agent transcript updates in current visibility", async () => {
    isSessionFileForAgent.mockResolvedValue(false);
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    expect(listener).toBeTypeOf("function");
    listener?.({ sessionFile: "/tmp/agents/other/sessions/a.jsonl" });

    await vi.runAllTimersAsync();

    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ignored session delta update outside current visibility"),
    );
  });

  it("batches transcript updates into one debounce sync", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    listener?.({ sessionFile: "/tmp/agents/main/sessions/b.jsonl" });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        agentId: "main",
        sessionFiles: ["/tmp/agents/main/sessions/a.jsonl", "/tmp/agents/main/sessions/b.jsonl"],
      }),
    );
  });

  it("unsubscribes and cancels pending debounce on lifecycle cleanup", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, getTranscriptListener, runCleanup, unsub } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });

    await runCleanup();
    await vi.runAllTimersAsync();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("accepts cross-agent transcript updates in visible visibility without current-agent filter", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    isSessionFileForAgent.mockResolvedValue(false);
    isSessionFileForAnyKnownAgent.mockResolvedValue(true);
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/other/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(isSessionFileForAgent).not.toHaveBeenCalled();
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/other/sessions/a.jsonl"],
      }),
    );
  });

  it("rejects unrecognized transcript path updates in visible visibility", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    isSessionFileForAnyKnownAgent.mockResolvedValue(false);
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/not-a-session-file.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ignored session delta update due to unrecognized path"),
    );
  });

  it("blocks memory_get sessions lookup in visible mode when session visibility guard denies access", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    canAccessSessionPathByVisibility.mockResolvedValueOnce({
      allowed: false,
      reason: "blocked by visibility policy",
    } as any);
    const { api } = buildApi();
    (plugin as any).register(api);

    const getRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_get");
    expect(getRegistration).toBeDefined();

    const result = await getRegistration.execute("toolcall-1", {
      lookup: "sessions/other/a.jsonl",
    });
    expect(result.content[0].text).toContain("blocked by visibility policy");
    expect(memoryGetFromDb).not.toHaveBeenCalled();
  });

  it("registers lifecycle cleanup through legacy api.registerRuntimeLifecycle when grouped lifecycle API is unavailable", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, getTranscriptListener, runCleanup, unsub } = buildApiLegacyLifecycle();
    (plugin as any).register(api);

    expect(api.registerRuntimeLifecycle).toHaveBeenCalledTimes(1);
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using legacy runtime lifecycle API"),
    );

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await runCleanup();
    await vi.runAllTimersAsync();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("warns and continues when runtime transcript update events API is unavailable", async () => {
    const { api } = buildApi();
    delete (api as any).runtime.events.onSessionTranscriptUpdate;

    expect(() => (plugin as any).register(api)).not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: runtime.events.onSessionTranscriptUpdate unavailable; sessions delta sync disabled",
    );
  });

  it("falls back to logger.warn when lifecycle API and logger.error are unavailable", async () => {
    const { api } = buildApi();
    delete (api as any).lifecycle;
    delete (api as any).registerRuntimeLifecycle;
    delete (api as any).logger.error;

    expect(() => (plugin as any).register(api)).not.toThrow();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: no runtime lifecycle registration API available; listener cleanup on reload/disable is unavailable",
    );
  });
});
