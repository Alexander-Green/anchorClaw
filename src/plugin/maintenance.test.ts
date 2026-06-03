import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMaintenanceRuntime } from "./maintenance.js";

const runMaintenanceCycle = vi.hoisted(() => vi.fn());

vi.mock("../maintenance/job.js", () => ({
  runMaintenanceCycle,
}));

function buildApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn() },
    runtime: { agentId: "main", sessionKey: "session-key" },
  } as any;
}

function buildCtx(overall: "pending" | "ready" | "blocked" | "degraded") {
  return {
    cfg: {
      workspaceDir: "/workspace",
      postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
      maintenance: {
        enabled: true,
        dryRun: false,
        intervalMinutes: 720,
        batchSize: 200,
        extractor: { enabled: true, agentId: "main", maxCandidates: 20, maxCharsPerRun: 12000 },
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

describe("createMaintenanceRuntime", () => {
  beforeEach(() => {
    runMaintenanceCycle.mockReset();
    runMaintenanceCycle.mockResolvedValue({
      status: "completed",
      runId: "run-1",
      scannedCount: 0,
      heuristicCandidateCount: 0,
      insertedCount: 0,
      skippedCount: 0,
      dryRun: false,
    });
  });

  it("skips non-dry-run maintenance until durable memory is ready", async () => {
    const api = buildApi();
    const ctx = buildCtx("pending");

    const runtime = createMaintenanceRuntime({ api, ctx });
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

    const runtime = createMaintenanceRuntime({ api, ctx });
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

    const runtime = createMaintenanceRuntime({ api, ctx });
    await Promise.resolve();
    await Promise.resolve();
    runtime.cleanupMaintenance();

    expect(runMaintenanceCycle).toHaveBeenCalledTimes(1);
  });
});
