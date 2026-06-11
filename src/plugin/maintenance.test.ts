import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceRuntime } from "./maintenance.js";

const runMaintenanceCycle = vi.hoisted(() => vi.fn());
const invalidatePromptMemory = vi.fn();

vi.mock("../maintenance/job.js", () => ({
  runMaintenanceCycle,
}));

function buildApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn() },
    runtime: {
      agentId: "main",
      sessionKey: "session-key",
      config: {
        current: () => ({
          agents: {
            list: [{ id: "main", default: true, workspace: "/workspace" }],
          },
        }),
      },
    },
  } as any;
}

function buildCtx(
  overall: "pending" | "ready" | "blocked" | "degraded",
  maintenanceOverrides?: Record<string, unknown>,
) {
  return {
    cfg: {
      postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
      maintenance: {
        enabled: true,
        dryRun: false,
        intervalMinutes: 720,
        batchSize: 200,
        workspaceScope: { mode: "default-agent" },
        extractor: { enabled: true, maxCandidates: 10, maxCharsPerRun: 12000 },
        ...maintenanceOverrides,
      },
    },
    durableState: {
      backend: "anchorclaw",
      overall,
      database: "ready",
      migrations: "ready",
      import: overall === "ready" ? "ready" : "pending",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: null,
      lastSourceSha256: null,
    },
    ensureReady: vi.fn(async () => {}),
    getPool: vi.fn(() => ({ query: vi.fn() })),
  } as any;
}

async function flushPromises(iterations = 12) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function completedMaintenanceResult() {
  return {
    status: "completed",
    runId: "run-1",
    scannedCount: 0,
    heuristicCandidateCount: 0,
    insertedCount: 0,
    skippedCount: 0,
    dryRun: false,
  };
}

describe("createMaintenanceRuntime", () => {
  beforeEach(() => {
    runMaintenanceCycle.mockReset();
    invalidatePromptMemory.mockReset();
    runMaintenanceCycle.mockResolvedValue(completedMaintenanceResult());
  });

  it("defers the first non-dry-run maintenance cycle until startup triggers it", async () => {
    const api = buildApi();
    const ctx = buildCtx("pending");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).not.toHaveBeenCalled();
    expect(api.logger.warn).not.toHaveBeenCalledWith(
      "anchorclaw: maintenance skipped until durable memory is ready (overall=pending)",
    );
  });

  it("does not keep short-lived CLI commands alive with the scheduler interval", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const unref = vi.fn();
    const interval = { unref };
    (globalThis as any).setInterval = vi.fn(() => interval);
    (globalThis as any).clearInterval = vi.fn();

    try {
      const api = buildApi();
      const ctx = buildCtx("pending");

      const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
      runtime.cleanupMaintenance();

      expect(unref).toHaveBeenCalledTimes(1);
      expect(globalThis.clearInterval).toHaveBeenCalledWith(interval);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("keeps the pending guard as a fallback when startup triggers too early", async () => {
    const api = buildApi();
    const ctx = buildCtx("pending");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();

    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).not.toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: maintenance skipped until durable memory is ready (overall=pending)",
    );
  });

  it("retries maintenance once startup marks durable memory ready", async () => {
    const api = buildApi();
    const ctx = buildCtx("pending");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();

    ctx.durableState = {
      ...ctx.durableState,
      overall: "ready",
      import: "ready",
    };
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
  });

  it("allows maintenance to run once durable memory is ready", async () => {
    const api = buildApi();
    const ctx = buildCtx("ready");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
    expect(invalidatePromptMemory).not.toHaveBeenCalled();
  });

  it("invalidates only the workspace where maintenance inserted durable memory", async () => {
    runMaintenanceCycle.mockResolvedValueOnce({
      status: "completed",
      runId: "run-1",
      scannedCount: 2,
      heuristicCandidateCount: 1,
      insertedCount: 1,
      skippedCount: 0,
      dryRun: false,
    });
    const api = buildApi();
    const ctx = buildCtx("ready");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(invalidatePromptMemory).toHaveBeenCalledWith({ workspaceDir: "/workspace" });
  });

  it("does not arm the scheduler until startMaintenance when autostart is disabled", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const unref = vi.fn();
    const interval = { unref };
    (globalThis as any).setInterval = vi.fn(() => interval);
    (globalThis as any).clearInterval = vi.fn();

    try {
      const api = buildApi();
      const ctx = buildCtx("ready");

      const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory, autostart: false });
      expect(globalThis.setInterval).not.toHaveBeenCalled();

      runtime.startMaintenance();
      expect(globalThis.setInterval).toHaveBeenCalledTimes(1);
      runtime.cleanupMaintenance();
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("replays a deferred trigger after startMaintenance arms the scheduler", async () => {
    const api = buildApi();
    const ctx = buildCtx("ready");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory, autostart: false });
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();

    expect(runMaintenanceCycle).not.toHaveBeenCalled();

    runtime.startMaintenance();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
  });

  it("does not start maintenance without an explicit workspace scope", () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    (globalThis as any).setInterval = vi.fn();
    (globalThis as any).clearInterval = vi.fn();

    try {
      const api = buildApi();
      const ctx = buildCtx("ready", { workspaceScope: undefined });

      const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
      runtime.cleanupMaintenance();

      expect(globalThis.setInterval).not.toHaveBeenCalled();
      expect(runMaintenanceCycle).not.toHaveBeenCalled();
      expect(api.logger.warn).toHaveBeenCalledWith(
        "anchorclaw: maintenance disabled because maintenance.workspaceScope is not configured",
      );
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("uses the resolved default-agent workspace without any global workspace fallback", async () => {
    const api = buildApi();
    (api as any).runtime.config.current = () => ({
      agents: {
        list: [{ id: "ops", default: true, workspace: "/agents/ops" }],
      },
    });
    const ctx = buildCtx("ready");

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
    expect(runMaintenanceCycle).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/agents/ops",
        agentId: "ops",
        sessionKey: undefined,
      }),
    );
  });

  it("fans out all unique agent workspaces and dedupes shared paths", async () => {
    const api = buildApi();
    (api as any).runtime.config.current = () => ({
      agents: {
        list: [
          { id: "main", default: true, workspace: "/agents/shared" },
          { id: "ops", workspace: "/agents/shared" },
          { id: "qa", workspace: "/agents/qa" },
        ],
      },
    });
    const ctx = buildCtx("ready", {
      workspaceScope: { mode: "all-agent-workspaces" },
    });

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runMaintenanceCycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/agents/shared",
        agentId: "main",
        sessionKey: "session-key",
      }),
    );
    expect(runMaintenanceCycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/agents/qa",
        agentId: "qa",
        sessionKey: undefined,
      }),
    );
  });

  it("resolves explicit agents scope and dedupes shared selected workspaces", async () => {
    const api = buildApi();
    (api as any).runtime.config.current = () => ({
      agents: {
        list: [
          { id: "main", default: true, workspace: "/agents/shared" },
          { id: "ops", workspace: "/agents/shared" },
          { id: "qa", workspace: "/agents/qa" },
        ],
      },
    });
    const ctx = buildCtx("ready", {
      workspaceScope: { mode: "agents", agents: ["ops", "main", "qa"] },
    });

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runMaintenanceCycle).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceDir: "/agents/shared",
        agentId: "ops",
        sessionKey: "session-key",
      }),
    );
    expect(runMaintenanceCycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/agents/qa",
        agentId: "qa",
        sessionKey: undefined,
      }),
    );
  });

  it("continues other selected workspaces when one maintenance cycle fails", async () => {
    runMaintenanceCycle
      .mockResolvedValueOnce({
        status: "failed",
        runId: "run-failed",
        scannedCount: 0,
        heuristicCandidateCount: 0,
        insertedCount: 0,
        skippedCount: 0,
        dryRun: false,
        error: "first workspace boom",
      })
      .mockResolvedValueOnce({
        status: "completed",
        runId: "run-ok",
        scannedCount: 2,
        heuristicCandidateCount: 1,
        insertedCount: 1,
        skippedCount: 0,
        dryRun: false,
      });

    const api = buildApi();
    (api as any).runtime.config.current = () => ({
      agents: {
        list: [
          { id: "main", default: true, workspace: "/agents/shared" },
          { id: "qa", workspace: "/agents/qa" },
        ],
      },
    });
    const ctx = buildCtx("ready", {
      workspaceScope: { mode: "all-agent-workspaces" },
    });

    const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
    await Promise.resolve();
    await Promise.resolve();
    runtime.triggerMaintenanceNow();
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(2);
    expect(runMaintenanceCycle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workspaceDir: "/agents/qa",
        agentId: "qa",
        sessionKey: undefined,
      }),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: maintenance cycle failed (agent main) (first workspace boom)",
    );
  });

  it("coalesces overlapping scheduler ticks into one rerun with freshly resolved targets", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const unref = vi.fn();
    const interval = { unref };
    let intervalCallback: (() => void) | undefined;
    (globalThis as any).setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return interval;
    });
    (globalThis as any).clearInterval = vi.fn();

    let releaseFirst: ((result: ReturnType<typeof completedMaintenanceResult>) => void) | undefined;
    let releaseRerun: ((result: ReturnType<typeof completedMaintenanceResult>) => void) | undefined;
    let invocation = 0;
    runMaintenanceCycle.mockImplementation(() => {
      invocation += 1;
      if (invocation === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (invocation === 3) {
        return new Promise((resolve) => {
          releaseRerun = resolve;
        });
      }
      return Promise.resolve(completedMaintenanceResult());
    });

    try {
      const api = buildApi();
      let runtimeConfig = {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/a" },
            { id: "ops", workspace: "/agents/b" },
          ],
        },
      };
      (api as any).runtime.config.current = () => runtimeConfig;
      const ctx = buildCtx("ready", {
        workspaceScope: { mode: "all-agent-workspaces" },
      });

      const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
      runtime.triggerMaintenanceNow();
      await flushPromises();

      expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
      expect(intervalCallback).toBeTypeOf("function");

      intervalCallback?.();
      intervalCallback?.();
      intervalCallback?.();
      runtimeConfig = {
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/a" },
            { id: "qa", workspace: "/agents/c" },
          ],
        },
      };

      releaseFirst?.(completedMaintenanceResult());
      await flushPromises(16);
      expect(runMaintenanceCycle).toHaveBeenCalledTimes(3);

      intervalCallback?.();
      intervalCallback?.();
      releaseRerun?.(completedMaintenanceResult());
      await flushPromises(24);
      runtime.cleanupMaintenance();

      expect(runMaintenanceCycle).toHaveBeenCalledTimes(4);
      expect(runMaintenanceCycle.mock.calls.map(([call]) => call.workspaceDir)).toEqual([
        "/agents/a",
        "/agents/b",
        "/agents/a",
        "/agents/c",
      ]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  it("does not start a queued rerun after maintenance cleanup", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const unref = vi.fn();
    const interval = { unref };
    let intervalCallback: (() => void) | undefined;
    (globalThis as any).setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return interval;
    });
    (globalThis as any).clearInterval = vi.fn();

    let releaseFirst: ((result: ReturnType<typeof completedMaintenanceResult>) => void) | undefined;
    runMaintenanceCycle
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(completedMaintenanceResult());

    try {
      const api = buildApi();
      (api as any).runtime.config.current = () => ({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/agents/a" },
            { id: "ops", workspace: "/agents/b" },
          ],
        },
      });
      const ctx = buildCtx("ready", {
        workspaceScope: { mode: "all-agent-workspaces" },
      });

      const runtime = createMaintenanceRuntime({ api, ctx, invalidatePromptMemory });
      runtime.triggerMaintenanceNow();
      await flushPromises();

      intervalCallback?.();
      runtime.cleanupMaintenance();
      releaseFirst?.(completedMaintenanceResult());
      await flushPromises(24);

      expect(runMaintenanceCycle).toHaveBeenCalledTimes(2);
      expect(runMaintenanceCycle.mock.calls.map(([call]) => call.workspaceDir)).toEqual([
        "/agents/a",
        "/agents/b",
      ]);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
