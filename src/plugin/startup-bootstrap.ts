import type { OpenClawPluginApi } from "../api.js";
import { scanLegacyWorkspace } from "../importer.js";
import { drainFlushInbox } from "./flush-inbox.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveConfiguredLegacyImportScope,
  resolveConfiguredWorkspaceDir,
  WORKSPACE_DIR_UNAVAILABLE,
} from "../workspace.js";

export type StartupBootstrapRuntime = {
  ensureStartupBootstrap: () => Promise<void>;
  kickoffStartupBootstrap: () => void;
};

export function createStartupBootstrapRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  refreshPromptCache: (options?: { force?: boolean }) => Promise<void>;
  triggerMaintenanceNow: () => void;
  ensureSessionDeltaListener: () => void;
}): StartupBootstrapRuntime {
  const { api, ctx, refreshPromptCache, triggerMaintenanceNow, ensureSessionDeltaListener } = params;
  let startupPromise: Promise<void> | null = null;

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

    api.logger.info("anchorclaw: startup step prompt-cache-warmup started");
    try {
      await refreshPromptCache({ force: true });
      if (ctx.promptCache.error) {
        api.logger.warn(`anchorclaw: startup step prompt-cache-warmup failed (${ctx.promptCache.error})`);
      } else {
        api.logger.info("anchorclaw: startup step prompt-cache-warmup succeeded");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: startup step prompt-cache-warmup failed (${message})`);
    }

    api.logger.info("anchorclaw: startup step flush-inbox-recovery started");
    try {
      const workspaceDir = resolveConfiguredWorkspaceDir(importCfg);
      if (workspaceDir) {
        const flushStats = await drainFlushInbox({
          api,
          ctx,
          workspaceDir,
        });
        api.logger.info(
          `anchorclaw: startup step flush-inbox-recovery succeeded (scanned=${flushStats.scannedFiles}, imported=${flushStats.importedFiles}, skipped=${flushStats.skippedImportedFiles})`,
        );
      } else {
        api.logger.warn(
          `anchorclaw: startup step flush-inbox-recovery skipped (${WORKSPACE_DIR_UNAVAILABLE})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: startup step flush-inbox-recovery failed (${message})`);
    }

    api.logger.info("anchorclaw: startup step legacy-import-scan started");
    try {
      const legacyImportScope = resolveConfiguredLegacyImportScope(importCfg);
      if (!legacyImportScope) {
        const reason = WORKSPACE_DIR_UNAVAILABLE;
        ctx.setDurableState({
          overall: "ready",
          import: "not_needed",
          cleanup: "not_needed",
          reason,
        });
        api.logger.warn(`anchorclaw: startup step legacy-import-scan skipped (${reason})`);
      } else {
        const legacyScan = await scanLegacyWorkspace({
          api,
          cfg: importCfg,
          pool: ctx.getPool(),
          sourceDir: legacyImportScope.sourceDir,
          targetWorkspaceDir: legacyImportScope.targetWorkspaceDir,
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
        });
        if (legacyScan.hasActiveLegacy) {
          api.logger.warn(
            `anchorclaw: active legacy memory files detected (${legacyScan.activeLegacyCount}); run openclaw anchorclaw import`,
          );
        } else {
          api.logger.info("anchorclaw: startup step legacy-import-scan found no active legacy files");
        }
      }
      ctx.setDurableState({
        overall: "ready",
        database: "ready",
        migrations: "ready",
        import: "not_needed",
        cleanup: "not_needed",
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
    if (!startupPromise) {
      startupPromise = runStartupBootstrap().catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn(`anchorclaw: startup bootstrap failed (${message})`);
        ctx.setStartupCriticalFailure(`startup_failed: ${message}`);
        ctx.setDurableState({
          overall: "blocked",
          reason: `startup_failed: ${message}`,
        });
      });
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
