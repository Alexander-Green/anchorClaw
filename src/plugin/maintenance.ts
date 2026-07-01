import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { runMaintenanceCycle } from "../maintenance/job.js";
import {
  resolveWorkspaceTargets,
  type ResolvedWorkspaceTarget,
  type WorkspaceTargetSelector,
} from "../workspace-targets.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

export type MaintenanceRuntime = {
  cleanupMaintenance: () => void;
  startMaintenance: () => void;
  triggerMaintenanceNow: () => void;
};

function resolveMaintenanceWorkspaceSelector(
  cfg: AnchorClawConfig,
): WorkspaceTargetSelector | undefined {
  const scope = cfg.maintenance?.workspaceScope;
  if (!scope) {
    return undefined;
  }
  if (scope.mode === "default-agent" || scope.mode === "all-agent-workspaces") {
    return { mode: scope.mode };
  }
  return { mode: "agents", agentIds: scope.agents };
}

function resolveConfiguredMaintenanceTargets(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
}): ResolvedWorkspaceTarget[] | undefined {
  const selector = resolveMaintenanceWorkspaceSelector(params.cfg);
  if (!selector) {
    params.api.logger.warn(
      "anchorclaw: maintenance disabled because maintenance.workspaceScope is not configured",
    );
    return undefined;
  }
  const runtimeConfig =
    typeof (params.api as any)?.runtime?.config?.current === "function"
      ? (params.api as any).runtime.config.current()
      : undefined;
  if (!runtimeConfig) {
    params.api.logger.warn(
      "anchorclaw: maintenance disabled because OpenClaw runtime config is unavailable",
    );
    return undefined;
  }
  try {
    return resolveWorkspaceTargets({
      runtimeConfig: runtimeConfig as any,
      selector,
    });
  } catch (error) {
    params.api.logger.warn(
      `anchorclaw: maintenance disabled because workspace scope could not be resolved (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

export function createMaintenanceRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  invalidatePromptMemory: (params: { workspaceDir: string }) => void;
  autostart?: boolean;
}): MaintenanceRuntime {
  const { api, ctx, invalidatePromptMemory } = params;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let started = false;
  let inFlight: Promise<void> | null = null;
  let rerunRequested = false;
  let rerunInProgress = false;
  let waitingForDurableReady = false;
  let initialRunDeferred = false;
  let pendingImmediateTrigger = false;

  function cleanupMaintenance() {
    stopped = true;
    rerunRequested = false;
    rerunInProgress = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  const runPass = async (
    jobCfg: NonNullable<AnchorClawConfig["maintenance"]>,
    targets: readonly ResolvedWorkspaceTarget[],
  ): Promise<boolean> => {
    await ctx.ensureReady();
    const dryRun = jobCfg.dryRun ?? true;
    if (!dryRun && ctx.durableState.overall !== "ready") {
      waitingForDurableReady = true;
      if (warnedDurableState !== ctx.durableState.overall) {
        warnedDurableState = ctx.durableState.overall;
        api.logger.warn(
          `anchorclaw: maintenance skipped until durable memory is ready (overall=${ctx.durableState.overall})`,
        );
      }
      return false;
    }
    waitingForDurableReady = false;
    warnedDurableState = null;
    const currentRuntimeAgentId = String((api as any)?.runtime?.agentId ?? "");
    const currentSessionKey = (api as any)?.runtime?.sessionKey;

    for (const target of targets) {
      const result = await runMaintenanceCycle({
        api,
        cfg: ctx.cfg!,
        pool: ctx.getPool(),
        workspaceDir: target.workspaceDir,
        agentId: target.primaryAgentId,
        sessionKey: target.agentIds.includes(currentRuntimeAgentId) ? currentSessionKey : undefined,
        dryRun,
        batchSize: jobCfg.batchSize ?? 200,
      });
      const labelSuffix = targets.length > 1 ? ` (${target.label})` : "";
      if (result.status === "failed") {
        api.logger.warn(
          `anchorclaw: maintenance cycle failed${labelSuffix} (${result.error ?? "unknown"})`,
        );
        continue;
      }
      if (result.insertedCount > 0) {
        invalidatePromptMemory({ workspaceDir: target.workspaceDir });
      }
      api.logger.info(
        `anchorclaw: maintenance cycle completed${labelSuffix} (dryRun=${result.dryRun}, scanned=${result.scannedCount}, heuristicCandidates=${result.heuristicCandidateCount}, inserted=${result.insertedCount}, skipped=${result.skippedCount}, semanticRequests=${result.semanticRequestCount}, semanticIndexed=${result.semanticIndexedCount}, semanticFailed=${result.semanticFailedCount})`,
      );
    }
    return true;
  };

  const runOnce = async (
    jobCfg: NonNullable<AnchorClawConfig["maintenance"]>,
    initialTargets?: readonly ResolvedWorkspaceTarget[],
  ) => {
    if (stopped) {
      return;
    }
    if (inFlight) {
      if (!rerunInProgress) {
        rerunRequested = true;
      }
      return;
    }
    inFlight = (async () => {
      rerunRequested = false;
      rerunInProgress = false;
      const passTargets =
        initialTargets ?? resolveConfiguredMaintenanceTargets({ api, cfg: ctx.cfg! });
      if (!passTargets || passTargets.length === 0) {
        return;
      }
      let canRerun = true;
      try {
        canRerun = await runPass(jobCfg, passTargets);
      } catch (error) {
        api.logger.warn(
          `anchorclaw: maintenance scheduler error (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (!canRerun || stopped || !rerunRequested) {
        return;
      }

      rerunRequested = false;
      rerunInProgress = true;
      const rerunTargets = resolveConfiguredMaintenanceTargets({ api, cfg: ctx.cfg! });
      if (!rerunTargets || rerunTargets.length === 0) {
        return;
      }
      try {
        await runPass(jobCfg, rerunTargets);
      } catch (error) {
        api.logger.warn(
          `anchorclaw: maintenance scheduler rerun error (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    })();
    try {
      await inFlight;
    } finally {
      rerunRequested = false;
      rerunInProgress = false;
      inFlight = null;
    }
  };

  let warnedDurableState: string | null = null;

  function scheduleIfEnabled(cfg: AnchorClawConfig) {
    const jobCfg = cfg.maintenance;
    if (!jobCfg?.enabled) {
      return;
    }
    const targets = resolveConfiguredMaintenanceTargets({ api, cfg });
    if (!targets || targets.length === 0) {
      return;
    }
    const intervalMinutes = jobCfg.intervalMinutes ?? 12 * 60;
    const intervalMs = intervalMinutes * 60_000;
    const dryRun = jobCfg.dryRun ?? true;
    initialRunDeferred = !dryRun;
    if (dryRun) {
      void runOnce(jobCfg, targets);
    }
    timer = setInterval(() => {
      void runOnce(jobCfg);
    }, intervalMs);
    timer.unref?.();
    api.logger.info(
      `anchorclaw: maintenance scheduler started (intervalMinutes=${intervalMinutes}, dryRun=${jobCfg.dryRun ?? true}, targets=${targets.length})`,
    );
  }

  const startMaintenance = () => {
    if (stopped || started || !ctx.cfg) {
      return;
    }
    started = true;
    scheduleIfEnabled(ctx.cfg);
    if (pendingImmediateTrigger) {
      pendingImmediateTrigger = false;
      if (ctx.cfg.maintenance?.enabled) {
        if (initialRunDeferred || waitingForDurableReady) {
          const targets = resolveConfiguredMaintenanceTargets({ api, cfg: ctx.cfg });
          if (!targets || targets.length === 0) {
            return;
          }
          initialRunDeferred = false;
          void runOnce(ctx.cfg.maintenance, targets);
        }
      }
    }
  };

  if (params.autostart !== false) {
    startMaintenance();
  }

  return {
    cleanupMaintenance,
    startMaintenance,
    triggerMaintenanceNow: () => {
      if (!ctx.cfg?.maintenance?.enabled) {
        return;
      }
      if (!started) {
        pendingImmediateTrigger = true;
        return;
      }
      if (!initialRunDeferred && !waitingForDurableReady) {
        return;
      }
      const targets = resolveConfiguredMaintenanceTargets({ api, cfg: ctx.cfg });
      if (!targets || targets.length === 0) {
        return;
      }
      initialRunDeferred = false;
      void runOnce(ctx.cfg.maintenance, targets);
    },
  };
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
