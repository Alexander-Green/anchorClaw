import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const {
  registerMemoryCapability,
  definePluginEntry,
  parseCfg,
  resolveScope,
  applyMigrations,
  loadMigrations,
  createPool,
  queryPromptItems,
  queryPromptDailyEntries,
  buildPromptSection,
  buildPromptDailySection,
  syncSessionsIndexDb,
  syncVisibleSessionsIndexDb,
  runImport,
  scanLegacyWorkspaceMock,
  getIdentityWarning,
  isSessionFileForAgent,
  resolveSessionsDirForAgent,
  memoryGetFromDb,
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
  createMaintenanceRuntimeMock,
  registerMaintenanceLifecycleMock,
  statFs,
  accessFs,
  openFs,
  readdirFs,
  readFileFs,
  unlinkFs,
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
  runCliImport,
  poolEnd,
  resolveMemorySearchConfigSdkMock,
  resolveAgentDirSdkMock,
  getEmbeddingProviderSdkMock,
  getMemoryEmbeddingProviderSdkMock,
} = vi.hoisted(() => ({
  registerMemoryCapability: vi.fn(),
  definePluginEntry: vi.fn((entry: unknown) => entry),
  parseCfg: vi.fn(),
  resolveScope: vi.fn(),
  applyMigrations: vi.fn(async () => ({ applied: [] as string[] })),
  loadMigrations: vi.fn(async () => []),
  createPool: vi.fn(),
  queryPromptItems: vi.fn(async () => []),
  queryPromptDailyEntries: vi.fn(async () => []),
  buildPromptSection: vi.fn(() => [] as string[]),
  buildPromptDailySection: vi.fn(() => [] as string[]),
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
  runImport: vi.fn(async () => ({
    overall: "ready",
    import: "not_needed",
    cleanup: "not_needed",
    reason: null,
    lastImportRunId: null,
    lastSourceSha256: null,
  })),
  scanLegacyWorkspaceMock: vi.fn(async () => ({
    sourceDir: "/tmp/work",
    targetWorkspaceDir: "/tmp/work",
    workspaceDir: "/tmp/work",
    memoryMd: { path: "MEMORY.md", state: "absent", sha256: null, importedSameSha: false },
    dailyFiles: [],
    activeLegacyCount: 0,
    pendingCount: 0,
    unsupportedCount: 0,
    unreadableCount: 0,
    hasActiveLegacy: false,
  })),
  getIdentityWarning: vi.fn(() => null),
  isSessionFileForAgent: vi.fn(async () => true),
  resolveSessionsDirForAgent: vi.fn(async () => "/tmp/.openclaw/agents/main/sessions"),
  memoryGetFromDb: vi.fn(),
  canAccessSessionPathByVisibility: vi.fn(async () => ({ allowed: true, reason: undefined as string | undefined })),
  filterSessionHitsByVisibility: vi.fn(async ({ hits }: { hits: unknown[] }) => hits),
  createMaintenanceRuntimeMock: vi.fn(() => ({
    cleanupMaintenance: vi.fn(),
    startMaintenance: vi.fn(),
    triggerMaintenanceNow: vi.fn(),
  })),
  registerMaintenanceLifecycleMock: vi.fn(),
  statFs: vi.fn(async () => ({ size: 0 })),
  accessFs: vi.fn(async () => undefined),
  openFs: vi.fn(async () => ({
    read: vi.fn(async () => ({ bytesRead: 0 })),
    close: vi.fn(async () => undefined),
  })),
  readdirFs: vi.fn(async () => {
    const error = Object.assign(new Error("not found"), { code: "ENOENT" });
    throw error;
  }),
  readFileFs: vi.fn(async () => ""),
  unlinkFs: vi.fn(async () => undefined),
  isSessionArchiveArtifactName: vi.fn((fileName: string) => /\.jsonl\.(reset|deleted)\./i.test(fileName)),
  isUsageCountedSessionTranscriptFileName: vi.fn((fileName: string) =>
    /\.jsonl($|\.reset\.|\.deleted\.)/i.test(fileName),
  ),
  runCliImport: vi.fn(async () => undefined),
  poolEnd: vi.fn(async () => undefined),
  resolveMemorySearchConfigSdkMock: vi.fn((runtimeConfig: any, agentId: string) => {
    const defaults = runtimeConfig?.agents?.defaults?.memorySearch;
    const agent = Array.isArray(runtimeConfig?.agents?.list)
      ? runtimeConfig.agents.list.find((entry: any) => entry?.id === agentId)
      : undefined;
    const memorySearch = agent?.memorySearch ?? defaults;
    if (!memorySearch?.provider || !memorySearch?.model) {
      return null;
    }
    if (memorySearch.enabled === false) {
      return null;
    }
    return {
      enabled: true,
      provider: memorySearch.provider,
      model: memorySearch.model,
      remote: memorySearch.remote ?? {},
      local: memorySearch.local ?? {},
      fallback: memorySearch.fallback ?? "none",
      inputType: memorySearch.inputType,
      queryInputType: memorySearch.queryInputType,
      documentInputType: memorySearch.documentInputType,
      outputDimensionality: memorySearch.outputDimensionality,
    };
  }),
  resolveAgentDirSdkMock: vi.fn(() => "/tmp/agent"),
  getEmbeddingProviderSdkMock: vi.fn(),
  getMemoryEmbeddingProviderSdkMock: vi.fn(),
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
  resolveSessionsSearchState: (cfg: any) => {
    const visibility = cfg?.sessions?.visibility ?? "current";
    const configured = cfg?.sessions?.search?.enabled === true;
    return {
      configured,
      visibility,
      effective: configured && visibility !== "off",
      reason: !configured ? "search_disabled" : visibility === "off" ? "visibility_off" : null,
    };
  },
  resolveSemanticLayerState: (cfg: any) => {
    const enabled = cfg?.semantic?.enabled === true;
    return {
      configured: enabled,
      enabled,
      effective: enabled,
      reason: enabled ? null : "semantic_disabled",
    };
  },
  resolveAgentMemorySearchConfig: ({ runtimeConfig, agentId }: any) => {
    const defaults = runtimeConfig?.agents?.defaults?.memorySearch;
    const agent = Array.isArray(runtimeConfig?.agents?.list)
      ? runtimeConfig.agents.list.find((entry: any) => entry?.id === agentId)
      : undefined;
    const memorySearch = agent?.memorySearch ?? defaults;
    return memorySearch
      ? {
          configured: true,
          source: agent?.memorySearch ? "agent" : "defaults",
          ...(memorySearch.provider ? { provider: memorySearch.provider } : {}),
          ...(memorySearch.model ? { model: memorySearch.model } : {}),
          ...(memorySearch.remote?.baseUrl ? { baseUrl: memorySearch.remote.baseUrl } : {}),
          apiKeyConfigured: Boolean(memorySearch.remote?.apiKey),
        }
      : {
          configured: false,
          source: null,
          apiKeyConfigured: false,
        };
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
vi.mock("./memory/prompt.js", () => ({
  queryPromptMemoryItems: queryPromptItems,
  queryPromptDailyEntries,
  buildPromptMemorySection: buildPromptSection,
  buildPromptDailySection,
}));

vi.mock("./memory/sessions.js", () => ({
  listKnownAgentIds: vi.fn(async () => []),
  memorySearchSessions: vi.fn(async () => []),
  isSessionFileForAgent,
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
  default: {
    stat: statFs,
    access: accessFs,
    open: openFs,
    readdir: readdirFs,
    readFile: readFileFs,
    unlink: unlinkFs,
  },
  stat: statFs,
  access: accessFs,
  open: openFs,
  readdir: readdirFs,
  readFile: readFileFs,
  unlink: unlinkFs,
}));

vi.mock("./memory/manager.js", () => ({
  createAnchorClawMemorySearchManager: vi.fn(),
}));

vi.mock("./importer.js", () => ({
  runOneTimeWorkspaceImport: runImport,
  scanLegacyWorkspace: scanLegacyWorkspaceMock,
}));

vi.mock("./scripts/import-legacy.js", () => ({
  runAnchorClawImport: runCliImport,
}));

vi.mock("./plugin/maintenance.js", () => ({
  createMaintenanceRuntime: createMaintenanceRuntimeMock,
  registerMaintenanceLifecycle: registerMaintenanceLifecycleMock,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", () => ({
  resolveMemorySearchConfig: resolveMemorySearchConfigSdkMock,
  resolveAgentDir: resolveAgentDirSdkMock,
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: getEmbeddingProviderSdkMock,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  getMemoryEmbeddingProvider: getMemoryEmbeddingProviderSdkMock,
}));

vi.mock("./identity-policy.js", () => ({
  getIdentityStartupWarning: getIdentityWarning,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  listSessionFilesForAgent: vi.fn(async () => []),
  sessionPathForFile: vi.fn((value: string) => {
    const normalized = value.replaceAll("\\", "/");
    const match = normalized.match(/\/agents\/([^/]+)\/sessions\/([^/]+)$/);
    return match
      ? `sessions/${match[1]}/${match[2]}`
      : `sessions/${normalized.split("/").filter(Boolean).at(-1) ?? ""}`;
  }),
  isSessionArchiveArtifactName,
  isUsageCountedSessionTranscriptFileName,
}));

import plugin from "./index.js";

type TranscriptUpdate = {
  sessionFile?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
};

function buildApi() {
  let transcriptListener: ((update: TranscriptUpdate) => void) | null = null;
  const lifecycleCleanups: Array<() => Promise<void> | void> = [];
  const serviceStarts: Array<() => Promise<void> | void> = [];
  const serviceStops: Array<() => Promise<void> | void> = [];
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
        current: () => ({
          plugins: { slots: { memory: "anchorclaw" } },
          agents: {
            list: [{ id: "main", default: true, workspace: "/tmp/work" }],
          },
        }),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn((listener: (update: TranscriptUpdate) => void) => {
          transcriptListener = listener;
          return unsub;
        }),
      },
    },
    lifecycle: {
      registerRuntimeLifecycle: vi.fn((registration: { cleanup?: () => Promise<void> | void }) => {
        if (registration.cleanup) {
          lifecycleCleanups.push(registration.cleanup);
        }
      }),
    },
    registerTool: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn((registration: { start?: () => Promise<void> | void; stop?: () => Promise<void> | void }) => {
      if (registration.start) {
        serviceStarts.push(registration.start);
      }
      if (registration.stop) {
        serviceStops.push(registration.stop);
      }
    }),
    on: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerHostedMediaResolver: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as any;

  return {
    api,
    getTranscriptListener: () => transcriptListener,
    runServiceStart: async () => {
      for (const start of serviceStarts) {
        await start();
      }
    },
    runCleanup: async () => {
      for (const stop of serviceStops) {
        await stop();
      }
      for (const cleanup of lifecycleCleanups) {
        await cleanup();
      }
    },
    unsub,
  };
}

function buildToolContext(api: any) {
  const runtimeConfig = api.runtime?.config?.current?.();
  return {
    runtimeConfig,
    getRuntimeConfig: api.runtime?.config?.current,
    workspaceDir: api.runtime?.workspaceDir,
    agentId: api.runtime?.agentId,
    sessionKey: api.runtime?.sessionKey,
  };
}

function registeredToolNames(api: any): string[] {
  const names: string[] = [];
  for (const [registration, opts] of (api.registerTool as any).mock.calls) {
    if (registration?.name && typeof registration.name === "string") {
      names.push(registration.name);
    }
    if (opts?.name && typeof opts.name === "string") {
      names.push(opts.name);
    }
    if (Array.isArray(opts?.names)) {
      names.push(...opts.names.filter((name: unknown): name is string => typeof name === "string"));
    }
  }
  return names;
}

function findRegisteredTool(api: any, name: string): any {
  for (const [registration, opts] of (api.registerTool as any).mock.calls) {
    if (registration?.name === name) {
      return registration;
    }
    const optsNames = [
      ...(typeof opts?.name === "string" ? [opts.name] : []),
      ...(Array.isArray(opts?.names) ? opts.names : []),
    ];
    if (typeof registration === "function" && optsNames.includes(name)) {
      return registration(buildToolContext(api));
    }
  }
  return undefined;
}

function buildApiLegacyLifecycle() {
  let transcriptListener: ((update: TranscriptUpdate) => void) | null = null;
  const lifecycleCleanups: Array<() => Promise<void> | void> = [];
  const serviceStarts: Array<() => Promise<void> | void> = [];
  const serviceStops: Array<() => Promise<void> | void> = [];
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
        current: () => ({
          plugins: { slots: { memory: "anchorclaw" } },
          agents: {
            list: [{ id: "main", default: true, workspace: "/tmp/work" }],
          },
        }),
      },
      events: {
        onSessionTranscriptUpdate: vi.fn((listener: (update: TranscriptUpdate) => void) => {
          transcriptListener = listener;
          return unsub;
        }),
      },
    },
    registerRuntimeLifecycle: vi.fn((registration: { cleanup?: () => Promise<void> | void }) => {
      if (registration.cleanup) {
        lifecycleCleanups.push(registration.cleanup);
      }
    }),
    registerTool: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn((registration: { start?: () => Promise<void> | void; stop?: () => Promise<void> | void }) => {
      if (registration.start) {
        serviceStarts.push(registration.start);
      }
      if (registration.stop) {
        serviceStops.push(registration.stop);
      }
    }),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerHostedMediaResolver: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
  } as any;

  return {
    api,
    getTranscriptListener: () => transcriptListener,
    runServiceStart: async () => {
      for (const start of serviceStarts) {
        await start();
      }
    },
    runCleanup: async () => {
      for (const stop of serviceStops) {
        await stop();
      }
      for (const cleanup of lifecycleCleanups) {
        await cleanup();
      }
    },
    unsub,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  statFs.mockResolvedValue({ size: 0 });
  accessFs.mockResolvedValue(undefined);
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
    sessions: { search: { enabled: true }, visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
    identity: { externalId: "test" },
    maintenance: { workspaceScope: { mode: "default-agent" } },
    workspaceDir: "/tmp/work",
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
    end: poolEnd,
  };
  createPool.mockReturnValue(pool);
  resolveScope.mockResolvedValue({ userId: "u1", workspaceId: "w1" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cli registration", () => {
  it("registers anchorclaw cli command metadata even when memory slot is different", () => {
    const { api } = buildApi();
    (api as any).runtime.config.current = () => ({ plugins: { slots: { memory: "memory-core" } } });

    (plugin as any).register(api);

    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect((api.registerCli as any).mock.calls[0][1]).toEqual({ commands: ["anchorclaw"] });
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('installed but not active (plugins.slots.memory="memory-core")'),
    );
  });

  it("keeps configuration diagnostics available without starting DB runtime", async () => {
    parseCfg.mockImplementation(() => {
      throw new Error("postgres config required");
    });
    const { api, runServiceStart } = buildApi();

    (plugin as any).register(api);
    await runServiceStart();

    expect(api.registerCli).toHaveBeenCalledTimes(1);
    expect(api.registerService).not.toHaveBeenCalled();
    expect(api.runtime.events.onSessionTranscriptUpdate).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerHook).not.toHaveBeenCalled();
    expect(createPool).not.toHaveBeenCalled();

    const capability = registerMemoryCapability.mock.calls[0]?.[1];
    expect(capability.promptBuilder()).toEqual([
      "AnchorClaw memory is disabled until configured (postgres config required).",
    ]);

    const statusTool = findRegisteredTool(api, "memory_status");
    const status = await statusTool.execute("toolcall-status", { check: true });
    expect(status.details).toEqual({
      disabled: true,
      error: "postgres config required",
    });
  });
});

describe("tool registration", () => {
  it("does not register memory_recall in Track A core surface", () => {
    const { api } = buildApi();

    (plugin as any).register(api);

    const toolNames = registeredToolNames(api);
    expect(toolNames).not.toContain("memory_recall");
  });

  it("registers durable and first-turn daily before_prompt_build hooks", () => {
    const { api } = buildApi();

    (plugin as any).register(api);

    const calls = (api.on as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const hasDailyHook = calls.some(
      (call: any[]) =>
        call[0] === "before_prompt_build" &&
        typeof call[1] === "function" &&
        call[2]?.name === "anchorclaw-daily-startup-injection",
    );
    const hasDurableHook = calls.some(
      (call: any[]) =>
        call[0] === "before_prompt_build" &&
        typeof call[1] === "function" &&
        call[2]?.name === "anchorclaw-durable-injection",
    );
    expect(hasDurableHook).toBe(true);
    expect(hasDailyHook).toBe(true);
  });

  it("registers a gateway-owned maintenance service on hosts that expose registerService", () => {
    const { api } = buildApi();

    (plugin as any).register(api);

    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "anchorclaw-maintenance",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
    expect(registerMaintenanceLifecycleMock).not.toHaveBeenCalled();
  });

  it("registers after_compaction hook for flush inbox drain", () => {
    const { api } = buildApi();

    (plugin as any).register(api);

    const calls = (api.registerHook as any).mock.calls;
    const hasFlushHook = calls.some(
      (call: any[]) =>
        call[0] === "after_compaction" &&
        typeof call[1] === "function" &&
        (call[2] === undefined || call[2]?.name === "anchorclaw-flush-inbox-drain"),
    );
    expect(hasFlushHook).toBe(true);
  });

  it("registers before_reset hook for DB-backed session capture", () => {
    const { api } = buildApi();

    (plugin as any).register(api);

    const calls = (api.on as any).mock.calls;
    const hasSessionCaptureHook = calls.some(
      (call: any[]) =>
        call[0] === "before_reset" &&
        typeof call[1] === "function" &&
        (call[2] === undefined || call[2]?.name === "anchorclaw-session-capture"),
    );
    expect(hasSessionCaptureHook).toBe(true);
  });
});

describe("phase2 session delta listener", () => {
  async function registerAndWaitStartup(runtime: { api: any; runServiceStart?: () => Promise<void> }) {
    (plugin as any).register(runtime.api);
    if (runtime.runServiceStart) {
      await runtime.runServiceStart();
    }
    await vi.runAllTimersAsync();
  }

  it("does not subscribe session delta listener when sessions search opt-in is disabled", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    expect(api.runtime.events.onSessionTranscriptUpdate).not.toHaveBeenCalled();
  });

  it("does not inject daily prompt context on continuation turns", async () => {
    parseCfg.mockReturnValue({
      debug: { promptLogEnabled: true },
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    expect(api.logger.info).toHaveBeenCalledWith(
      "anchorclaw: daily startup prompt hook registered (named before_prompt_build)",
    );

    const call = (api.on as any).mock.calls.find(
      (row: any[]) => row[0] === "before_prompt_build" && row[2]?.name === "anchorclaw-daily-startup-injection",
    );
    const hook = call?.[1];
    expect(hook).toBeTypeOf("function");

    const result = await hook({ prompt: "continue", messages: [{ role: "user", content: "hi" }] });
    expect(result).toBeUndefined();
    expect(queryPromptDailyEntries).not.toHaveBeenCalled();
    expect(buildPromptDailySection).not.toHaveBeenCalled();
    expect(api.logger.info).toHaveBeenCalledWith(
      "anchorclaw: daily startup prompt hook invoked (messages=1)",
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      "anchorclaw: daily startup prompt injection skipped (messages=1)",
    );
  });

  it("passes session-capture entries into a dedicated startup prompt section", async () => {
    parseCfg.mockReturnValue({
      debug: { promptLogEnabled: true },
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    queryPromptDailyEntries.mockResolvedValueOnce([
      {
        id: "capture-1",
        path: "memory/2026-06-02-1819-a1b2c3d4-session-capture.md",
        logicalDate: "2026-06-02",
        content: "user: remember the reset capture canary",
        sourceKind: "session_memory",
        createdAt: "2026-06-02T18:19:00.000Z",
        updatedAt: "2026-06-02T18:19:00.000Z",
      },
      {
        id: "daily-1",
        path: "memory/2026-06-02.md",
        logicalDate: "2026-06-02",
        content: "x".repeat(8_000),
        sourceKind: "memory_log",
        createdAt: "2026-06-02T10:00:00.000Z",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
    ] as any);
    buildPromptDailySection.mockReturnValueOnce([
      "[Startup context loaded by AnchorClaw]",
      "daily context",
      "",
      "[Untrusted daily memory: recent-session-capture-1]",
      "session capture context",
    ]);
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    expect(api.logger.info).toHaveBeenCalledWith(
      "anchorclaw: daily startup prompt hook registered (named before_prompt_build)",
    );

    const call = (api.on as any).mock.calls.find(
      (row: any[]) => row[0] === "before_prompt_build" && row[2]?.name === "anchorclaw-daily-startup-injection",
    );
    const hook = call?.[1];
    expect(hook).toBeTypeOf("function");

    const result = await hook({ prompt: "fresh turn", messages: [] });

    expect(result).toEqual({
      prependContext: [
        "[Startup context loaded by AnchorClaw]",
        "daily context",
        "",
        "[Untrusted daily memory: recent-session-capture-1]",
        "session capture context",
      ].join("\n"),
    });
    expect(buildPromptDailySection).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            path: "memory/2026-06-02-1819-a1b2c3d4-session-capture.md",
            sourceKind: "session_memory",
          }),
        ]),
        maxSessionCaptures: 4,
        maxDailyEntries: 4,
      }),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      "anchorclaw: daily startup prompt hook invoked (messages=0)",
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("anchorclaw: daily startup prompt injection applied"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("session_memory:memory/2026-06-02-1819-a1b2c3d4-session-capture.md"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("memory_log:memory/2026-06-02.md"),
    );
    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("[Untrusted daily memory: recent-session-capture-1]"),
    );
  });

  it("uses before_prompt_build hook context workspace and agent for daily injection", async () => {
    queryPromptDailyEntries.mockResolvedValueOnce([
      {
        id: "daily-ops-1",
        path: "memory/2026-06-02.md",
        logicalDate: "2026-06-02",
        content: "ops context",
        sourceKind: "memory_log",
        createdAt: "2026-06-02T10:00:00.000Z",
        updatedAt: "2026-06-02T10:00:00.000Z",
      },
    ] as any);
    buildPromptDailySection.mockReturnValueOnce(["ops daily context"]);
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          { id: "ops", workspace: "/agents/ops" },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const call = (api.on as any).mock.calls.find(
      (row: any[]) => row[0] === "before_prompt_build" && row[2]?.name === "anchorclaw-daily-startup-injection",
    );
    const hook = call?.[1];
    expect(hook).toBeTypeOf("function");

    const result = await hook(
      { prompt: "fresh ops turn", messages: [] },
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        workspaceDir: "/agents/ops",
      },
    );

    expect(result).toEqual({ prependContext: "ops daily context" });
    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: path.resolve("/agents/ops"),
        agentId: "ops",
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("routes another agent transcript to its configured workspace in current visibility", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValue(new Error("ENOENT"));
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          { id: "other", workspace: "/tmp/other" },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    expect(listener).toBeTypeOf("function");
    listener?.({
      sessionFile: "/tmp/agents/other/sessions/a.jsonl",
      agentId: "other",
      sessionKey: "agent:other:main",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: path.resolve("/tmp/other"),
        agentId: "other",
        sessionKey: "agent:other:main",
      }),
    );
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "other",
        sessionFiles: ["/tmp/agents/other/sessions/a.jsonl"],
      }),
    );
  });

  it("batches transcript updates into one debounce sync", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValue(new Error("ENOENT"));
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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

  it("partitions one transcript debounce batch by owning agent workspace", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValue(new Error("ENOENT"));
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          { id: "ops", workspace: "/tmp/ops" },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({
      sessionFile: "/tmp/agents/main/sessions/a.jsonl",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    listener?.({
      sessionFile: "/tmp/agents/ops/sessions/b.jsonl",
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: path.resolve("/tmp/work"),
        agentId: "main",
      }),
    );
    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: path.resolve("/tmp/ops"),
        agentId: "ops",
      }),
    );
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(2);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionFiles: ["/tmp/agents/main/sessions/a.jsonl"],
      }),
    );
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        sessionFiles: ["/tmp/agents/ops/sessions/b.jsonl"],
      }),
    );
  });

  it("unsubscribes and cancels pending debounce on lifecycle cleanup", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, getTranscriptListener, runCleanup, runServiceStart, unsub } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });

    await runCleanup();
    await vi.runAllTimersAsync();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("closes the runtime postgres pool during cleanup only once", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, runCleanup, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    await runCleanup();

    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it("accepts cross-agent transcript updates in visible visibility for a shared workspace", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValue(new Error("ENOENT"));
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          { id: "other", workspace: "/tmp/work" },
          { id: "qa", workspace: "/tmp/qa" },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/other/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(isSessionFileForAgent).toHaveBeenCalledWith({
      sessionFile: "/tmp/agents/other/sessions/a.jsonl",
      agentId: "other",
    });
    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/other/sessions/a.jsonl"],
      }),
    );
  });

  it("routes visible transcript updates to the owning separate workspace", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
    });
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockRejectedValue(new Error("ENOENT"));
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          { id: "other", workspace: "/tmp/other" },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({
      sessionFile: "/tmp/agents/other/sessions/a.jsonl",
      agentId: "other",
      sessionKey: "agent:other:main",
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(resolveScope).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: path.resolve("/tmp/other"),
        agentId: "other",
      }),
    );
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "other",
        sessionFiles: ["/tmp/agents/other/sessions/a.jsonl"],
      }),
    );
  });

  it("rejects transcript updates when event agent and path agent disagree", async () => {
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({
      sessionFile: "/tmp/agents/other/sessions/a.jsonl",
      agentId: "main",
    });
    await vi.runAllTimersAsync();

    expect(isSessionFileForAgent).not.toHaveBeenCalled();
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("agent/path mismatch"),
    );
  });

  it("does not sync when transcript deltas stay below thresholds", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValue({ size: 100 });
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("syncs after message threshold is reached for repeated updates", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const content = "\n\n";
    statFs.mockResolvedValueOnce({ size: 1 }).mockResolvedValueOnce({ size: 2 });
    openFs.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const start = Math.max(0, Math.min(content.length, position ?? 0));
        const end = Math.min(content.length, start + length);
        const chunk = Buffer.from(content.slice(start, end), "utf8");
        chunk.copy(buffer, offset, 0, chunk.length);
        return { bytesRead: chunk.length };
      }),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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

  it("does not count append without trailing newline toward message threshold", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const content = '{"type":"message","role":"assistant","content":"unterminated"}';
    const size = Buffer.byteLength(content, "utf8");
    statFs.mockResolvedValueOnce({ size });
    openFs.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const start = Math.max(0, Math.min(content.length, position ?? 0));
        const end = Math.min(content.length, start + length);
        const chunk = Buffer.from(content.slice(start, end), "utf8");
        chunk.copy(buffer, offset, 0, chunk.length);
        return { bytesRead: chunk.length };
      }),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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

  it("counts newline-delimited records in mixed transcript appends", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const chunk1 = '{"type":"header"}\n';
    const chunk2 = '{"type":"custom","value":"still-counted"}\n';
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
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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
        search: { enabled: true },
        visibility: "current",
        sync: { deltaBytes: 100_000, deltaMessages: 1 },
      },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    isSessionFileForAgent.mockResolvedValue(true);
    const content = "\n";
    statFs.mockResolvedValueOnce({ size: 1 });
    openFs.mockResolvedValue({
      read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
        const start = Math.max(0, Math.min(content.length, position ?? 0));
        const end = Math.min(content.length, start + length);
        const chunk = Buffer.from(content.slice(start, end), "utf8");
        chunk.copy(buffer, offset, 0, chunk.length);
        return { bytesRead: chunk.length };
      }),
      close: vi.fn(async () => undefined),
    });
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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

  it("schedules targeted sync when thresholds are zero and file changed", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: {
        search: { enabled: true },
        visibility: "current",
        sync: { deltaBytes: 0, deltaMessages: 0 },
      },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    isSessionFileForAgent.mockResolvedValue(true);
    statFs.mockResolvedValue({ size: 1 });
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/changed.jsonl" });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(syncSessionsIndexDb).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFiles: ["/tmp/agents/main/sessions/changed.jsonl"],
      }),
    );
  });

  it("rejects unrecognized transcript path updates in visible visibility", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    isSessionFileForAgent.mockResolvedValue(false);
    const { api, getTranscriptListener, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

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
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    canAccessSessionPathByVisibility.mockResolvedValueOnce({
      allowed: false,
      reason: "blocked by visibility policy",
    } as any);
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const getRegistration = findRegisteredTool(api, "memory_get");
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
      sessions: { search: { enabled: true }, visibility: "current" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    canAccessSessionPathByVisibility.mockResolvedValueOnce({
      allowed: false,
      reason: "blocked by visibility policy",
    } as any);
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const getRegistration = findRegisteredTool(api, "memory_get");
    expect(getRegistration).toBeDefined();

    const result = await getRegistration.execute("toolcall-2", {
      lookup: "sessions/main/a.jsonl",
    });
    expect(result.content[0].text).toContain("blocked by visibility policy");
    expect(memoryGetFromDb).not.toHaveBeenCalled();
  });

  it("registers lifecycle cleanup through legacy api.registerRuntimeLifecycle when grouped lifecycle API is unavailable", async () => {
    isSessionFileForAgent.mockResolvedValue(true);
    const { api, getTranscriptListener, runCleanup, runServiceStart, unsub } = buildApiLegacyLifecycle();
    delete (api as any).registerService;
    await registerAndWaitStartup({ api, runServiceStart });

    expect(api.registerRuntimeLifecycle).toHaveBeenCalledTimes(1);
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: plugin service API unavailable; starting startup bootstrap and maintenance eagerly for compatibility",
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("using legacy runtime lifecycle API"),
    );

    const listener = getTranscriptListener();
    listener?.({ sessionFile: "/tmp/agents/main/sessions/a.jsonl" });
    await runCleanup();
    await vi.runAllTimersAsync();

    expect(unsub).toHaveBeenCalledTimes(1);
    expect(poolEnd).toHaveBeenCalledTimes(1);
    expect(syncSessionsIndexDb).not.toHaveBeenCalled();
  });

  it("warns and continues when runtime transcript update events API is unavailable", async () => {
    const { api, runServiceStart } = buildApi();
    delete (api as any).runtime.events.onSessionTranscriptUpdate;

    await registerAndWaitStartup({ api, runServiceStart });
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
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
    });
    filterSessionHitsByVisibility.mockRejectedValueOnce(new Error("visibility helper failed"));
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const searchRegistration = findRegisteredTool(api, "memory_search");
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
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
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
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const searchRegistration = findRegisteredTool(api, "memory_search");
    const getRegistration = findRegisteredTool(api, "memory_get");
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
      sessions: { search: { enabled: true }, visibility: "visible" },
      identity: { externalId: "test" },
      workspaceDir: "/tmp/work",
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
    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });

    const searchRegistration = findRegisteredTool(api, "memory_search");
    const getRegistration = findRegisteredTool(api, "memory_get");
    const statusRegistration = findRegisteredTool(api, "memory_status");
    expect(searchRegistration).toBeDefined();
    expect(getRegistration).toBeDefined();
    expect(statusRegistration).toBeDefined();

    await searchRegistration.execute("toolcall-search-status-1", {
      query: "needle",
      corpus: "sessions",
    });
    const degraded = await statusRegistration.execute("toolcall-status-1", {});
    expect(degraded.details.sdk.degraded).toBe(true);
    expect(degraded.details.daily).toMatchObject({
      source: "db",
      injectionMode: "first_turn",
      promptInjectionAllowed: true,
      startupPromptEnabled: true,
      startupPromptEffective: true,
      readCompatibilityPath: "db-only",
      importMode: "canonical_table",
    });

    await getRegistration.execute("toolcall-get-status-1", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-status-2", { lookup: "sessions/main/a.jsonl" });
    await getRegistration.execute("toolcall-get-status-3", { lookup: "sessions/main/a.jsonl" });
    const healthy = await statusRegistration.execute("toolcall-status-2", {});
    expect(healthy.details.sdk.degraded).toBe(false);
  });

  it("reports resolved semantic memorySearch source/provider/model via memory_status", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      semantic: { enabled: true },
    });
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).agentId = "ops";
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          {
            id: "ops",
            workspace: "/tmp/ops",
            memorySearch: {
              provider: "ollama",
              model: "nomic-embed-text",
              remote: { baseUrl: "http://127.0.0.1:11434", apiKey: "${OLLAMA_KEY}" },
            },
          },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const statusRegistration = findRegisteredTool(api, "memory_status");
    const result = await statusRegistration.execute("toolcall-status-semantic-1", {});
    expect(result.details.semantic).toMatchObject({
      configured: true,
      enabled: true,
      effective: true,
      source: "agent",
      provider: "ollama",
      model: "nomic-embed-text",
      baseUrl: "http://127.0.0.1:11434",
      apiKeyConfigured: true,
    });
  });

  it("reports semantic error when semantic is enabled but provider/model are not configured", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      semantic: { enabled: true },
    });
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/work" }],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const statusRegistration = findRegisteredTool(api, "memory_status");
    const result = await statusRegistration.execute("toolcall-status-semantic-2", {});
    expect(result.details.semantic).toMatchObject({
      configured: true,
      enabled: true,
      effective: true,
      error: "semantic enabled but memorySearch.provider/model is not configured for the active agent",
    });
  });

  it("reports semantic provider probe details during active memory_status check", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: true,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: "memory_item_embeddings",
                semantic_indexing_requests: "semantic_indexing_requests",
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: "semantic_schema_migrations",
              },
            ],
          };
        }
        if (queryText.includes("semantic_schema_migrations")) {
          return { rows: [{ id: "0002" }] };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0010" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      semantic: { enabled: true },
    });
    getEmbeddingProviderSdkMock.mockReturnValueOnce({
      create: vi.fn(async () => ({
        provider: {
          id: "openai-compatible",
          model: "text-embedding-3-small",
          embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
          close: vi.fn(),
        },
      })),
    });

    const { api, runServiceStart } = buildApi();
    (api.runtime as any).agentId = "ops";
    (api.runtime as any).workspaceDir = "/tmp/ops";
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
        },
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          {
            id: "ops",
            workspace: "/tmp/ops",
            memorySearch: {
              provider: "openai-compatible",
              model: "text-embedding-3-small",
              remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
            },
          },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const statusRegistration = findRegisteredTool(api, "memory_status");
    const result = await statusRegistration.execute("toolcall-status-semantic-active-probe-1", {
      check: true,
    });
    expect(result.details.semantic.error).toBeUndefined();
    expect(result.details.semantic).toMatchObject({
      configured: true,
      enabled: true,
      effective: true,
      schemaReady: true,
      schemaVersion: "0002",
      vectorExtensionInstalled: true,
      indexingRequestsTableReady: true,
      source: "agent",
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKeyConfigured: true,
      checked: true,
      providerKind: "generic",
      providerReachable: true,
      dimensions: 1536,
    });
    expect(result.details.semantic.profileKey).toHaveLength(64);
    expect(typeof result.details.semantic.checkedAtMs).toBe("number");
  });

  it("reports semantic schema gaps without blocking the base runtime", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: false,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: null,
                semantic_indexing_requests: null,
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: null,
              },
            ],
          };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0010" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      semantic: { enabled: true },
    });
    getEmbeddingProviderSdkMock.mockReturnValueOnce({
      create: vi.fn(async () => ({
        provider: {
          id: "openai-compatible",
          model: "text-embedding-3-small",
          embed: vi.fn(async () => Array.from({ length: 1536 }, () => 0.01)),
          close: vi.fn(),
        },
      })),
    });

    const { api, runServiceStart } = buildApi();
    (api.runtime as any).agentId = "ops";
    (api.runtime as any).workspaceDir = "/tmp/ops";
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/tmp/work" },
          {
            id: "ops",
            workspace: "/tmp/ops",
            memorySearch: {
              provider: "openai-compatible",
              model: "text-embedding-3-small",
              remote: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "${EMBED_KEY}" },
            },
          },
        ],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const statusRegistration = findRegisteredTool(api, "memory_status");
    const result = await statusRegistration.execute("toolcall-status-semantic-active-probe-gap-1", {
      check: true,
    });

    expect(result.details.database?.ok).toBe(true);
    expect(result.details.semantic).toMatchObject({
      configured: true,
      enabled: true,
      schemaReady: false,
      vectorExtensionInstalled: false,
      providerReachable: true,
      error:
        "semantic schema not ready (pgvector extension, memory_item_embeddings, semantic_indexing_requests, semantic_schema_migrations missing)",
    });
  });

  it("runs active checks via memory_status when check=true", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: true,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: "memory_item_embeddings",
                semantic_indexing_requests: "semantic_indexing_requests",
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: "semantic_schema_migrations",
              },
            ],
          };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0002" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });

    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    const statusRegistration = findRegisteredTool(api, "memory_status");
    expect(statusRegistration).toBeDefined();

    const result = await statusRegistration.execute("toolcall-status-active-1", { check: true });
    expect(result.details).toMatchObject({
      ok: true,
      mode: "active",
      database: {
        ok: true,
        schemaOk: true,
        dailySchemaOk: true,
        migrationVersion: "0002",
      },
      daily: {
        source: "db",
        injectionMode: "first_turn",
        promptInjectionAllowed: true,
        startupPromptEnabled: true,
        startupPromptEffective: true,
        readCompatibilityPath: "db-only",
        importMode: "canonical_table",
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

  it("reports readable=false when sessions dir exists but read access is denied", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: true,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: "memory_item_embeddings",
                semantic_indexing_requests: "semantic_indexing_requests",
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: "semantic_schema_migrations",
              },
            ],
          };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0002" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });
    accessFs.mockRejectedValueOnce(new Error("EACCES"));

    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    const statusRegistration = findRegisteredTool(api, "memory_status");
    expect(statusRegistration).toBeDefined();

    const result = await statusRegistration.execute("toolcall-status-active-2", { check: true });
    expect(result.details.sessions).toMatchObject({
      enabled: true,
      visibility: "current",
      exists: true,
      readable: false,
    });
  });

  it("logs semantic warning during active memory_status check when semantic config is incomplete", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: true,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: "memory_item_embeddings",
                semantic_indexing_requests: "semantic_indexing_requests",
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: "semantic_schema_migrations",
              },
            ],
          };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0002" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      semantic: { enabled: true },
    });

    const { api, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [{ id: "main", default: true, workspace: "/tmp/work" }],
      },
    });
    await registerAndWaitStartup({ api, runServiceStart });

    const statusRegistration = findRegisteredTool(api, "memory_status");
    const result = await statusRegistration.execute("toolcall-status-semantic-active-1", {
      check: true,
    });
    expect(result.details.semantic).toMatchObject({
      error: "semantic enabled but memorySearch.provider/model is not configured for the active agent",
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "anchorclaw: semantic status check warning (semantic enabled but memorySearch.provider/model is not configured for the active agent)",
      ),
    );
  });

  it("reports migrations failure via memory_status active check when ensureReady fails", async () => {
    applyMigrations.mockRejectedValueOnce(new Error("generation expression is not immutable"));

    const { api, runServiceStart } = buildApi();
    await registerAndWaitStartup({ api, runServiceStart });
    const statusRegistration = findRegisteredTool(api, "memory_status");
    expect(statusRegistration).toBeDefined();

    const result = await statusRegistration.execute("toolcall-status-active-migrations-1", { check: true });
    expect(result.content[0].text).toContain("AnchorClaw memory is blocked");
    expect(result.details).toMatchObject({
      ok: false,
      overall: "blocked",
      migrationsState: "failed",
      reason: "migrations_failed: generation expression is not immutable",
      database: {
        ok: false,
        error: "migrations_failed: generation expression is not immutable",
      },
    });
  });

  it("uses resolved runtime workspace for memory_status legacy import active check", async () => {
    const pool = {
      query: vi.fn(async (sql?: string) => {
        const queryText = String(sql ?? "");
        if (queryText.includes("to_regclass(")) {
          return {
            rows: [
              {
                vector_extension_installed: true,
                memory_items: "memory_items",
                memory_daily_entries: "memory_daily_entries",
                memory_daily_blocks: "memory_daily_blocks",
                memory_daily_block_extraction_windows:
                  "memory_daily_block_extraction_windows",
                memory_item_embeddings: "memory_item_embeddings",
                semantic_indexing_requests: "semantic_indexing_requests",
                session_index_files: "session_index_files",
                session_index_chunks: "session_index_chunks",
                schema_migrations: "schema_migrations",
                semantic_schema_migrations: "semantic_schema_migrations",
              },
            ],
          };
        }
        if (queryText.includes("schema_migrations")) {
          return { rows: [{ id: "0002" }] };
        }
        return { rows: [] };
      }),
      connect: vi.fn(async () => ({
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      })),
    };
    createPool.mockReturnValue(pool);
    statFs.mockResolvedValueOnce({ size: 1 });
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "current" },
      identity: { externalId: "test" },
      maintenance: { workspaceScope: { mode: "default-agent" } },
      workspaceDir: "/cfg/workspace",
    });
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).workspaceDir = "/runtime/workspace";
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
      },
    });

    await registerAndWaitStartup({ api, runServiceStart });
    const statusRegistration = findRegisteredTool(api, "memory_status");
    expect(statusRegistration).toBeDefined();

    await statusRegistration.execute("toolcall-status-active-runtime-workspace-1", { check: true });

    expect(scanLegacyWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: path.resolve("/runtime/workspace"),
        targetWorkspaceDir: path.resolve("/runtime/workspace"),
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });

  it("warns when startup scan finds active legacy files", async () => {
    scanLegacyWorkspaceMock.mockResolvedValueOnce({
      workspaceDir: "/tmp/work",
      memoryMd: { path: "MEMORY.md", state: "pending", sha256: "sha-1", importedSameSha: false },
      dailyFiles: [
        {
          path: "memory/2026-06-01.md",
          logicalDate: "2026-06-01",
          sha256: "sha-daily-1",
          supported: true,
          importedSameSha: false,
          state: "pending",
        },
      ],
      activeLegacyCount: 2,
      pendingCount: 2,
      unsupportedCount: 0,
      hasActiveLegacy: true,
    } as any);
    const { api, runServiceStart } = buildApi();

    await registerAndWaitStartup({ api, runServiceStart });

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "anchorclaw: active legacy memory files detected (2; agent main, /tmp/work); run openclaw anchorclaw import",
      ),
    );
    expect(api.logger.info).not.toHaveBeenCalledWith(
      "anchorclaw: startup step legacy-import-scan found no active legacy files (agent main, /tmp/work)",
    );
  });

  it("logs legacy import scan failure without blocking startup", async () => {
    scanLegacyWorkspaceMock.mockRejectedValueOnce(new Error("EACCES"));
    const { api, runServiceStart } = buildApi();

    await registerAndWaitStartup({ api, runServiceStart });

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("anchorclaw: startup step legacy-import-scan failed (agent main, /tmp/work, EACCES)"),
    );
  });

  it("uses resolved runtime workspace scope as the startup scan source of truth", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
      maintenance: { workspaceScope: { mode: "default-agent" } },
      workspaceDir: "/cfg/workspace",
    });
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).workspaceDir = "/runtime/ignored-workspace";
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
      },
    });

    await registerAndWaitStartup({ api, runServiceStart });

    expect(scanLegacyWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: path.resolve("/runtime/workspace"),
        targetWorkspaceDir: path.resolve("/runtime/workspace"),
      }),
    );
  });

  it("fans out startup legacy scan across all unique agent workspaces and dedupes shared paths", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
      maintenance: { workspaceScope: { mode: "all-agent-workspaces" } },
      workspaceDir: "/cfg/workspace",
    });
    scanLegacyWorkspaceMock
      .mockResolvedValueOnce({
        workspaceDir: "/agents/shared",
        memoryMd: { path: "MEMORY.md", state: "absent", sha256: null, importedSameSha: false },
        dailyFiles: [],
        activeLegacyCount: 0,
        pendingCount: 0,
        unsupportedCount: 0,
        hasActiveLegacy: false,
      } as any)
      .mockResolvedValueOnce({
        workspaceDir: "/agents/qa",
        memoryMd: { path: "MEMORY.md", state: "absent", sha256: null, importedSameSha: false },
        dailyFiles: [],
        activeLegacyCount: 0,
        pendingCount: 0,
        unsupportedCount: 0,
        hasActiveLegacy: false,
      } as any);
    const { api, runServiceStart } = buildApi();
    (api.runtime as any).config.current = () => ({
      plugins: { slots: { memory: "anchorclaw" } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/agents/shared" },
          { id: "ops", workspace: "/agents/shared" },
          { id: "qa", workspace: "/agents/qa" },
        ],
      },
    });

    await registerAndWaitStartup({ api, runServiceStart });

    expect(scanLegacyWorkspaceMock).toHaveBeenCalledTimes(2);
    expect(scanLegacyWorkspaceMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sourceDir: path.resolve("/agents/shared"),
        targetWorkspaceDir: path.resolve("/agents/shared"),
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
    expect(scanLegacyWorkspaceMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceDir: path.resolve("/agents/qa"),
        targetWorkspaceDir: path.resolve("/agents/qa"),
        agentId: "qa",
        sessionKey: undefined,
      }),
    );
  });

  it("skips startup background coverage when maintenance.workspaceScope is not configured", async () => {
    parseCfg.mockReturnValue({
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
      sessions: { search: { enabled: true }, visibility: "current", sync: { deltaBytes: 4_096, deltaMessages: 2 } },
      identity: { externalId: "test" },
    });
    const { api, runServiceStart } = buildApi();

    await registerAndWaitStartup({ api, runServiceStart });

    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: startup background coverage disabled because maintenance.workspaceScope is not configured",
    );
    expect(scanLegacyWorkspaceMock).not.toHaveBeenCalled();
  });

});
