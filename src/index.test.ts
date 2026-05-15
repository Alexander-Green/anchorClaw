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
  syncVisibleSessionsIndexDb,
  runImport,
  getIdentityWarning,
  isSessionFileForAgent,
  isSessionFileForAnyKnownAgent,
  resolveSessionsDirForAgent,
  memoryGetFromDb,
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
  statFs,
  openFs,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
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
  syncVisibleSessionsIndexDb: vi.fn(async () => ({
    indexedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    removedFiles: 0,
  })),
  runImport: vi.fn(async () => undefined),
  getIdentityWarning: vi.fn(() => null),
  isSessionFileForAgent: vi.fn(async () => true),
  isSessionFileForAnyKnownAgent: vi.fn(async () => true),
  resolveSessionsDirForAgent: vi.fn(async () => "/tmp/.openclaw/agents/main/sessions"),
  memoryGetFromDb: vi.fn(),
  canAccessSessionPathByVisibility: vi.fn(async () => ({ allowed: true, reason: undefined as string | undefined })),
  filterSessionHitsByVisibility: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
  statFs: vi.fn(async () => ({ size: 0 })),
  openFs: vi.fn(async () => ({
    read: vi.fn(async () => ({ bytesRead: 0 })),
    close: vi.fn(async () => undefined),
  })),
  isSessionArchiveArtifactName: vi.fn((fileName: string) => /\.jsonl\.(reset|deleted)\./i.test(fileName)),
  isUsageCountedSessionTranscriptFileName: vi.fn((fileName: string) =>
    /\.jsonl($|\.reset\.|\.deleted\.)/i.test(fileName),
  ),
}));

vi.mock("./api.js", () => ({
  definePluginEntry,
  registerMemoryCapability,
}));

vi.mock("./config.js", () => ({
  anchorClawConfigSchema: {
    parse: parseCfg,
  },
  DEFAULT_SESSION_DELTA_BYTES: 100_000,
  DEFAULT_SESSION_DELTA_MESSAGES: 50,
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
  resolveSessionsDirForAgent,
}));

vi.mock("./memory/sessions-index.js", () => ({
  hasSessionsIndexRows: vi.fn(async () => false),
  memorySearchSessionsIndexDb: vi.fn(async () => []),
  normalizeSessionLookupPath: vi.fn((value: string) => value),
}));

vi.mock("./memory/sessions-index-sync.js", () => ({
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
}));

vi.mock("./memory/sessions-visibility.js", () => ({
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
}));

vi.mock("node:fs/promises", () => ({
  default: { stat: statFs, open: openFs },
  stat: statFs,
  open: openFs,
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
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
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
  statFs.mockResolvedValue({ size: 0 });
  openFs.mockResolvedValue({
    read: vi.fn(async () => ({ bytesRead: 0 })),
    close: vi.fn(async () => undefined),
  });
  isSessionArchiveArtifactName.mockImplementation((fileName: string) => /\.jsonl\.(reset|deleted)\./i.test(fileName));
  isUsageCountedSessionTranscriptFileName.mockImplementation((fileName: string) =>
    /\.jsonl($|\.reset\.|\.deleted\.)/i.test(fileName),
  );
  parseCfg.mockReturnValue({
    postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
    sessions: { visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
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
    statFs.mockRejectedValue(new Error("ENOENT"));
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
    statFs.mockRejectedValue(new Error("ENOENT"));
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

  it("does not sync when transcript deltas stay below thresholds", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValue({ size: 100 });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("syncs after message threshold is reached for repeated updates", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs
      .mockResolvedValueOnce({ size: 100 })
      .mockResolvedValueOnce({ size: 150 });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();

    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/a.jsonl"],
      }),
    );
  });

  it("treats append without trailing newline as one pending message", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValueOnce({ size: 120 });
    openFs.mockResolvedValue({
      read: vi.fn(async () => ({ bytesRead: 10 })),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/no-trailing-newline.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("carries pending delta overflow after sync instead of resetting to zero", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValueOnce({ size: 10_000 }).mockResolvedValueOnce({ size: 10_100 });
    openFs.mockResolvedValue({
      read: vi
        .fn()
        .mockResolvedValueOnce({ bytesRead: 1 })
        .mockResolvedValueOnce({ bytesRead: 0 })
        .mockResolvedValueOnce({ bytesRead: 1 })
        .mockResolvedValueOnce({ bytesRead: 0 }),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);

    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(2);
  });

  it("bypasses thresholds for reset/deleted archive artifacts", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValueOnce(new Error("ENOENT"));
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl.reset.2026-05-14T10-00-00Z" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/a.jsonl.reset.2026-05-14T10-00-00Z"],
      }),
    );
  });

  it("counts only usage-counted JSONL message records in mixed transcript appends", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const chunk1 = [
      '{"type":"header"}',
      '{"type":"custom","value":"ignored"}',
      '{"type":"metadata","value":"ignored"}',
      "",
    ].join("\n");
    const chunk2 = '{"type":"message","role":"assistant","content":"counted"}\n';
    const fullContent = `${chunk1}${chunk2}`;
    const size1 = Buffer.byteLength(chunk1, "utf8");
    const size2 = Buffer.byteLength(fullContent, "utf8");
    statFs.mockResolvedValueOnce({ size: size1 }).mockResolvedValueOnce({ size: size2 });
    openFs.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const start = Math.max(0, Math.min(fullContent.length, position ?? 0));
        const end = Math.min(fullContent.length, start + length);
        const chunk = Buffer.from(fullContent.slice(start, end), "utf8");
        chunk.copy(buffer, offset, 0, chunk.length);
        return { bytesRead: chunk.length };
      }),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/mixed.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    listener?.({ sessionFile: "/tmp/agents/main/sessions/mixed.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/mixed.jsonl"],
      }),
    );
  });

  it("applies configured sessions.sync deltaMessages threshold", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: {
        visibility: "current",
        sync: { deltaBytes: 100_000, deltaMessages: 1 },
      },
      identity: { externalId: "test" },
    });
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValueOnce({ size: 120 });
    openFs.mockResolvedValue({
      read: vi.fn(async () => ({ bytesRead: 10 })),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/one-message.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/one-message.jsonl"],
      }),
    );
  });

  it("schedules targeted sync when thresholds are zero", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: {
        visibility: "current",
        sync: { deltaBytes: 0, deltaMessages: 0 },
      },
      identity: { externalId: "test" },
    });
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValue({ size: 0 });
    const { api, getTranscriptListener } = buildApi();
    (plugin as any).register(api);
    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/unchanged.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/unchanged.jsonl"],
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

  it("blocks memory_get sessions lookup in current mode when session visibility guard denies access", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "current" },
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

    const result = await getRegistration.execute("toolcall-2", {
      lookup: "sessions/main/a.jsonl",
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

  it("returns degraded details when memory_search hits sdk/runtime error", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    filterSessionHitsByVisibility.mockRejectedValueOnce(new Error("visibility helper failed"));
    const { api } = buildApi();
    (plugin as any).register(api);

    const searchRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_search");
    expect(searchRegistration).toBeDefined();

    const result = await searchRegistration.execute("toolcall-search-1", {
      query: "needle",
      corpus: "sessions",
    });
    expect(result.content[0].text).toContain("memory_search degraded");
    expect(result.details).toMatchObject({
      degraded: true,
      degradedReason: "sdk_error",
    });
    expect(result.details.sdk).toMatchObject({
      degraded: true,
      affectedOperation: "memory_search:sessions",
    });
  });

  it("recovers sdk degraded state after consecutive successful operations", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    filterSessionHitsByVisibility.mockRejectedValueOnce(new Error("visibility helper failed"));
    memoryGetFromDb.mockResolvedValue({
      ok: true,
      corpus: "sessions",
      path: "sessions/main/a.jsonl",
      kind: "session",
      content: "ok",
      fromLine: 1,
      lineCount: 1,
    });
    const { api } = buildApi();
    (plugin as any).register(api);

    const searchRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_search");
    const getRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_get");
    expect(searchRegistration).toBeDefined();
    expect(getRegistration).toBeDefined();

    const degraded = await searchRegistration.execute("toolcall-search-2", {
      query: "needle",
      corpus: "sessions",
    });
    expect(degraded.details.degraded).toBe(true);

    await getRegistration.execute("toolcall-get-1", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-2", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-3", { lookup: "sessions/main/a.jsonl" });

    const healthy = await searchRegistration.execute("toolcall-search-3", {
      query: "needle",
      corpus: "memory",
    });
    expect(healthy.details.degraded).toBeUndefined();

    const capability = registerMemoryCapability.mock.calls[0]?.[1];
    const lines = capability?.promptBuilder?.({ availableTools: new Set(["memory_search", "memory_get"]) }) ?? [];
    const hasSdkDegradedNotice = lines.some(
      (line: string) => typeof line === "string" && line.includes("sessions SDK is degraded"),
    );
    expect(hasSdkDegradedNotice).toBe(false);
  });

  it("exposes sdk health via memory_status tool", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "visible" },
      identity: { externalId: "test" },
    });
    filterSessionHitsByVisibility.mockRejectedValueOnce(new Error("visibility helper failed"));
    memoryGetFromDb.mockResolvedValue({
      ok: true,
      corpus: "sessions",
      path: "sessions/main/a.jsonl",
      kind: "session",
      content: "ok",
      fromLine: 1,
      lineCount: 1,
    });
    const { api } = buildApi();
    (plugin as any).register(api);

    const searchRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_search");
    const getRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_get");
    const statusRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_status");
    expect(searchRegistration).toBeDefined();
    expect(getRegistration).toBeDefined();
    expect(statusRegistration).toBeDefined();

    await searchRegistration.execute("toolcall-search-status-1", {
      query: "needle",
      corpus: "sessions",
    });
    const degraded = await statusRegistration.execute("toolcall-status-1", {});
    expect(degraded.details.sdk.degraded).toBe(true);

    await getRegistration.execute("toolcall-get-status-1", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-status-2", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-status-3", { lookup: "sessions/main/a.jsonl" });
    const healthy = await statusRegistration.execute("toolcall-status-2", {});
    expect(healthy.details.sdk.degraded).toBe(false);
  });

  it("runs active checks via memory_status when check=true", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    (pool.query as any)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            memory_items: "memory_items",
            session_index_files: "session_index_files",
            session_index_chunks: "session_index_chunks",
            schema_migrations: "schema_migrations",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "0002" }] });
    statFs.mockResolvedValueOnce({ size: 1 });

    const { api } = buildApi();
    (plugin as any).register(api);
    const statusRegistration = (api.registerTool as any).mock.calls
      .map((call: any[]) => call[0])
      .find((tool: any) => tool?.name === "memory_status");
    expect(statusRegistration).toBeDefined();

    const result = await statusRegistration.execute("toolcall-status-active-1", { check: true });
    expect(result.details).toMatchObject({
      ok: true,
      mode: "active",
      database: {
        ok: true,
        schemaOk: true,
        migrationVersion: "0002",
      },
      sessions: {
        enabled: true,
        visibility: "current",
        exists: true,
        readable: true,
      },
    });
    expect(typeof result.details.database.latencyMs).toBe("number");
  });
});
