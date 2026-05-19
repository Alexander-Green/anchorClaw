import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { runMaintenanceCycle } from "../maintenance/job.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

export type MaintenanceRuntime = {
  cleanupMaintenance: () => void;
};

export function createMaintenanceRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}): MaintenanceRuntime {
  const { api, ctx } = params;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  function cleanupMaintenance() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function scheduleIfEnabled(cfg: AnchorClawConfig) {
    const jobCfg = cfg.maintenance;
    if (!jobCfg?.enabled) {
      return;
    }
    const intervalMinutes = jobCfg.intervalMinutes ?? 12 * 60;
    const intervalMs = intervalMinutes * 60_000;
    let warnedDurableState: string | null = null;
    const runOnce = async () => {
      if (stopped || inFlight) {
        return;
      }
      inFlight = (async () => {
        try {
          await ctx.ensureReady();
          const dryRun = jobCfg.dryRun ?? true;
          if (!dryRun && ctx.durableState.overall !== "ready") {
            if (warnedDurableState !== ctx.durableState.overall) {
              warnedDurableState = ctx.durableState.overall;
              api.logger.warn(
                `anchorclaw: maintenance skipped until durable memory is ready (overall=${ctx.durableState.overall})`,
              );
            }
            return;
          }
          warnedDurableState = null;
          const workspaceDir = cfg.workspaceDir;
          const result = await runMaintenanceCycle({
            api,
            cfg,
            pool: ctx.getPool(),
            workspaceDir,
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
            dryRun,
            batchSize: jobCfg.batchSize ?? 200,
          });
          if (result.status === "failed") {
            api.logger.warn(
              `anchorclaw: maintenance cycle failed (${result.error ?? "unknown"})`,
            );
            return;
          }
          api.logger.info(
            `anchorclaw: maintenance cycle completed (dryRun=${result.dryRun}, scanned=${result.scannedCount}, heuristicCandidates=${result.heuristicCandidateCount}, inserted=${result.insertedCount}, skipped=${result.skippedCount})`,
          );
        } catch (error) {
          api.logger.warn(
            `anchorclaw: maintenance scheduler error (${error instanceof Error ? error.message : String(error)})`,
          );
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
    };

    void runOnce();
    timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    api.logger.info(
      `anchorclaw: maintenance scheduler started (intervalMinutes=${intervalMinutes}, dryRun=${jobCfg.dryRun ?? true})`,
    );
  }

  if (ctx.cfg) {
    scheduleIfEnabled(ctx.cfg);
  }

  return { cleanupMaintenance };
}

export function registerMaintenanceLifecycle(params: {
  api: OpenClawPluginApi;
  cleanupMaintenance: () => void;
}) {
  const { api, cleanupMaintenance } = params;
  const registerRuntimeLifecycle = (api as any)?.lifecycle?.registerRuntimeLifecycle;
  const registerRuntimeLifecycleCompat =
    typeof registerRuntimeLifecycle === "function"
      ? registerRuntimeLifecycle.bind((api as any).lifecycle)
      : typeof (api as any)?.registerRuntimeLifecycle === "function"
        ? (api as any).registerRuntimeLifecycle.bind(api)
        : null;
  if (!registerRuntimeLifecycleCompat) {
    return;
  }
  registerRuntimeLifecycleCompat({
    id: "anchorclaw-maintenance-scheduler",
    description: "Stops AnchorClaw background maintenance scheduler.",
    cleanup: async () => {
      cleanupMaintenance();
    },
  });
}
