import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { scanLegacyWorkspace } from "../importer.js";
import {
  resolveWorkspaceTargets,
  type ResolvedWorkspaceTarget,
  type WorkspaceTargetSelector,
} from "../workspace-targets.js";
import { drainFlushInbox } from "./flush-inbox.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";

export type StartupBootstrapRuntime = {
  ensureStartupBootstrap: () => Promise<void>;
  kickoffStartupBootstrap: () => void;
};

const STARTUP_RETRY_BASE_DELAY_MS = 500;
const STARTUP_RETRY_MAX_DELAY_MS = 30_000;

function resolveStartupWorkspaceSelector(
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

function resolveStartupBootstrapTargets(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
}): ResolvedWorkspaceTarget[] | undefined {
  const selector = resolveStartupWorkspaceSelector(params.cfg);
  if (!selector) {
    params.api.logger.warn(
      "anchorclaw: startup background coverage disabled because maintenance.workspaceScope is not configured",
    );
    return undefined;
  }
  const runtimeConfig =
    typeof (params.api as any)?.runtime?.config?.current === "function"
      ? (params.api as any).runtime.config.current()
      : undefined;
  if (!runtimeConfig) {
    params.api.logger.warn(
      "anchorclaw: startup background coverage disabled because OpenClaw runtime config is unavailable",
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
      `anchorclaw: startup background coverage disabled because workspace scope could not be resolved (${error instanceof Error ? error.message : String(error)})`,
    );
    return undefined;
  }
}

function buildStartupTargetLabel(target: ResolvedWorkspaceTarget): string {
  return `${target.label}, ${target.workspaceDir}`;
}

export function createStartupBootstrapRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  triggerMaintenanceNow: () => void;
  ensureSessionDeltaListener: () => void;
}): StartupBootstrapRuntime {
  const { api, ctx, triggerMaintenanceNow, ensureSessionDeltaListener } = params;
  let startupPromise: Promise<void> | null = null;
  let retryAttempt = 0;
  let retryNotBeforeMs = 0;

  const runStartupBootstrap = async () => {
    if (!ctx.cfg) {
      return;
    }
    const importCfg = ctx.cfg;
    ctx.setStartupCriticalFailure(undefined);
    ctx.setDurableState({
      overall: "pending",
      database: "pending",
      migrations: "pending",
      import: "not_needed",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: null,
      lastSourceSha256: null,
    });
    api.logger.info("anchorclaw: startup step db-readiness started");
    try {
      await ctx.ensureConnectionReady();
      ctx.setDurableState({ database: "ready" });
      api.logger.info("anchorclaw: startup step db-readiness succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: startup step db-readiness failed (${message})`);
      ctx.setStartupCriticalFailure(`db_readiness_failed: ${message}`);
      ctx.setDurableState({
        overall: "blocked",
        database: "failed",
        migrations: "failed",
        import: "failed_retryable",
        cleanup: "not_needed",
        reason: `db_readiness_failed: ${message}`,
      });
      return;
    }

    api.logger.info("anchorclaw: startup step migrations started");
    try {
      await ctx.ensureReady();
      ctx.setDurableState({ database: "ready", migrations: "ready" });
      api.logger.info("anchorclaw: startup step migrations succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: startup step migrations failed (${message})`);
      ctx.setStartupCriticalFailure(`migrations_failed: ${message}`);
      ctx.setDurableState({
        overall: "blocked",
        migrations: "failed",
        import: "failed_retryable",
        cleanup: "not_needed",
        reason: `migrations_failed: ${message}`,
      });
      return;
    }

    api.logger.info("anchorclaw: startup step flush-inbox-recovery started");
    const startupTargets = resolveStartupBootstrapTargets({ api, cfg: importCfg });
    if (!startupTargets || startupTargets.length === 0) {
      api.logger.warn(
        `anchorclaw: startup step flush-inbox-recovery skipped (${RUNTIME_WORKSPACE_UNAVAILABLE})`,
      );
    } else {
      for (const target of startupTargets) {
        const targetLabel = buildStartupTargetLabel(target);
        try {
          const flushStats = await drainFlushInbox({
            api,
            ctx,
            workspaceDir: target.workspaceDir,
            agentId: target.primaryAgentId,
          });
          api.logger.info(
            `anchorclaw: startup step flush-inbox-recovery succeeded (${targetLabel}, scanned=${flushStats.scannedFiles}, imported=${flushStats.importedFiles}, skipped=${flushStats.skippedImportedFiles})`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          api.logger.warn(
            `anchorclaw: startup step flush-inbox-recovery failed (${targetLabel}, ${message})`,
          );
        }
      }
    }

    api.logger.info("anchorclaw: startup step legacy-import-scan started");
    try {
      let startupImportReason: string | null = null;
      if (!startupTargets || startupTargets.length === 0) {
        const reason = RUNTIME_WORKSPACE_UNAVAILABLE;
        startupImportReason = reason;
        ctx.setDurableState({
          overall: "ready",
          import: "not_needed",
          cleanup: "not_needed",
          reason,
        });
        api.logger.warn(`anchorclaw: startup step legacy-import-scan skipped (${reason})`);
      } else {
        const currentRuntimeAgentId = String((api as any)?.runtime?.agentId ?? "");
        let firstScanFailure: string | null = null;
        for (const target of startupTargets) {
          const targetLabel = buildStartupTargetLabel(target);
          try {
            const legacyScan = await scanLegacyWorkspace({
              api,
              cfg: importCfg,
              pool: ctx.getPool(),
              sourceDir: target.workspaceDir,
              targetWorkspaceDir: target.workspaceDir,
              agentId: target.primaryAgentId,
              sessionKey: target.agentIds.includes(currentRuntimeAgentId)
                ? (api as any)?.runtime?.sessionKey
                : undefined,
            });
            if (legacyScan.hasActiveLegacy) {
              api.logger.warn(
                `anchorclaw: active legacy memory files detected (${legacyScan.activeLegacyCount}; ${targetLabel}); run openclaw anchorclaw import`,
              );
            } else {
              api.logger.info(
                `anchorclaw: startup step legacy-import-scan found no active legacy files (${targetLabel})`,
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!firstScanFailure) {
              firstScanFailure = message;
            }
            api.logger.warn(
              `anchorclaw: startup step legacy-import-scan failed (${targetLabel}, ${message})`,
            );
          }
        }
        if (firstScanFailure) {
          startupImportReason = `legacy_import_scan_failed: ${firstScanFailure}`;
        }
      }
      ctx.setDurableState({
        overall: "ready",
        database: "ready",
        migrations: "ready",
        import: "not_needed",
        cleanup: "not_needed",
        reason: startupImportReason,
        lastImportRunId: null,
        lastSourceSha256: null,
      });
      ctx.setStartupCriticalFailure(undefined);
      triggerMaintenanceNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.setDurableState({
        overall: "ready",
        import: "not_needed",
        cleanup: "not_needed",
        reason: `legacy_import_scan_failed: ${message}`,
      });
      triggerMaintenanceNow();
      api.logger.warn(
        `anchorclaw: legacy import scan failed (${message})`,
      );
      api.logger.warn(
        `anchorclaw: startup step legacy-import-scan failed (${message})`,
      );
    }
    if (ctx.durableState.overall !== "blocked") {
      ensureSessionDeltaListener();
    }
  };

  const ensureStartupBootstrap = async () => {
    if (ctx.disabledReason || !ctx.cfg) {
      return;
    }
    const retryableFailure =
      ctx.durableState.overall === "blocked" &&
      ctx.durableState.import === "failed_retryable";
    if (!startupPromise && retryableFailure && Date.now() < retryNotBeforeMs) {
      return;
    }
    if (!startupPromise) {
      const currentPromise = runStartupBootstrap().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn(`anchorclaw: startup bootstrap failed (${message})`);
        ctx.setStartupCriticalFailure(`startup_failed: ${message}`);
        ctx.setDurableState({
          overall: "blocked",
          reason: `startup_failed: ${message}`,
        });
      });
      startupPromise = currentPromise;
      await currentPromise;

      if (
        startupPromise === currentPromise &&
        ctx.durableState.overall === "blocked" &&
        ctx.durableState.import === "failed_retryable"
      ) {
        retryAttempt += 1;
        const retryDelayMs = Math.min(
          STARTUP_RETRY_BASE_DELAY_MS * 2 ** (retryAttempt - 1),
          STARTUP_RETRY_MAX_DELAY_MS,
        );
        retryNotBeforeMs = Date.now() + retryDelayMs;
        startupPromise = null;
        api.logger.warn(
          `anchorclaw: startup bootstrap retry deferred for ${retryDelayMs}ms (attempt=${retryAttempt})`,
        );
      } else if (ctx.durableState.overall === "ready") {
        retryAttempt = 0;
        retryNotBeforeMs = 0;
      }
      return;
    }
    await startupPromise;
  };

  return {
    ensureStartupBootstrap,
    kickoffStartupBootstrap: () => {
      void ensureStartupBootstrap();
    },
  };
}
