import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../importer.js", () => ({
  scanLegacyWorkspace: vi.fn(async () => ({
    hasActiveLegacy: false,
    activeLegacyCount: 0,
  })),
}));

vi.mock("./flush-inbox.js", () => ({
  drainFlushInbox: vi.fn(async () => ({
    scannedFiles: 0,
    importedFiles: 0,
    skippedImportedFiles: 0,
  })),
}));

import { createStartupBootstrapRuntime } from "./startup-bootstrap.js";

function buildHarness() {
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    runtime: {
      agentId: "main",
      sessionKey: "agent:main:main",
      config: {
        current: () => ({
          agents: {
            list: [
              {
                id: "main",
                default: true,
                workspace: "/agents/main",
              },
            ],
          },
        }),
      },
    },
  } as any;
  const ctx = {
    api,
    cfg: {
      postgres: {
        host: "localhost",
        database: "anchorclaw",
        user: "anchorclaw",
      },
      maintenance: {
        workspaceScope: {
          mode: "default-agent",
        },
      },
    },
    disabledReason: undefined,
    startupCriticalFailure: undefined,
    durableState: {
      backend: "anchorclaw",
      overall: "pending",
      database: "pending",
      migrations: "pending",
      import: "pending",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: null,
      lastSourceSha256: null,
    },
    ensureConnectionReady: vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(undefined),
    ensureReady: vi.fn(async () => undefined),
    getPool: vi.fn(() => ({})),
    setStartupCriticalFailure(reason: string | undefined) {
      this.startupCriticalFailure = reason;
    },
    setDurableState(next: Record<string, unknown>) {
      this.durableState = {
        ...this.durableState,
        ...next,
      };
    },
  } as any;
  const triggerMaintenanceNow = vi.fn();
  const ensureSessionDeltaListener = vi.fn();
  const runtime = createStartupBootstrapRuntime({
    api,
    ctx,
    triggerMaintenanceNow,
    ensureSessionDeltaListener,
  });

  return {
    api,
    ctx,
    triggerMaintenanceNow,
    ensureSessionDeltaListener,
    runtime,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createStartupBootstrapRuntime", () => {
  it("retries a transient startup failure after backoff without a gateway restart", async () => {
    const {
      ctx,
      triggerMaintenanceNow,
      ensureSessionDeltaListener,
      runtime,
    } = buildHarness();

    await runtime.ensureStartupBootstrap();

    expect(ctx.ensureConnectionReady).toHaveBeenCalledTimes(1);
    expect(ctx.durableState.overall).toBe("blocked");
    expect(ctx.durableState.import).toBe("failed_retryable");

    await runtime.ensureStartupBootstrap();
    expect(ctx.ensureConnectionReady).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([
      runtime.ensureStartupBootstrap(),
      runtime.ensureStartupBootstrap(),
    ]);

    expect(ctx.ensureConnectionReady).toHaveBeenCalledTimes(2);
    expect(ctx.ensureReady).toHaveBeenCalledTimes(1);
    expect(ctx.durableState.overall).toBe("ready");
    expect(ctx.startupCriticalFailure).toBeUndefined();
    expect(triggerMaintenanceNow).toHaveBeenCalledTimes(1);
    expect(ensureSessionDeltaListener).toHaveBeenCalledTimes(1);
  });
});
