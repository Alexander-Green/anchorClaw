import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  anchorClawConfigSchema,
  type AnchorClawConfig,
} from "./config.js";
import { scanLegacyWorkspace } from "./importer.js";
import { getIdentityStartupWarning } from "./identity-policy.js";
import {
  createPluginRuntimeContext,
  type PluginRuntimeContext,
} from "./plugin/runtime-context.js";
import { createPromptCacheRuntime } from "./plugin/prompt-cache.js";
import { registerAnchorClawMemoryCapability } from "./plugin/capability.js";
import { registerDailyPromptHook } from "./plugin/daily-prompt.js";
import { drainFlushInbox, registerAnchorClawFlushInboxHook } from "./plugin/flush-inbox.js";
import { registerSessionDeltaLifecycle } from "./plugin/lifecycle.js";
import { createMaintenanceRuntime, registerMaintenanceLifecycle } from "./plugin/maintenance.js";
import { createSessionDeltaRuntime } from "./plugin/session-delta.js";
import { registerAnchorClawSessionCaptureHook } from "./plugin/session-capture.js";
import { registerAnchorClawSystemOverrideHook } from "./plugin/system-override.js";
import { registerAnchorClawTools } from "./plugin/tools/index.js";
import { runAnchorClawSetup } from "./scripts/setup-db.js";
import { runAnchorClawImport } from "./scripts/import-legacy.js";
import { resolveConfiguredWorkspaceDir, WORKSPACE_DIR_UNAVAILABLE } from "./workspace.js";

export default definePluginEntry({
  id: "anchorclaw",
  name: "AnchorClaw",
  description: "Postgres-backed long-term memory plugin",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    if (typeof (api as any).registerCli === "function") {
      (api as any).registerCli(({ program }: { program: any }) => {
        const anchorclaw = program.command("anchorclaw").description("AnchorClaw database management");
        anchorclaw
          .command("setup")
          .description("Create and initialize AnchorClaw PostgreSQL resources")
          .option("--admin-url <url>", "PostgreSQL superuser connection string (default: postgres://localhost/postgres)")
          .option("--db-name <name>", "Database name (default: anchorclaw)")
          .option("--db-user <user>", "App user name (default: anchorclaw)")
          .option("--db-password <pass>", "App user password (auto-generated if omitted)")
          .option("--rotate-db-password", "Allow password rotation for an existing app user")
          .option("--schema <name>", 'Schema name (default: memory, use "none" for search_path/public fallback)')
          .option("--workspace-dir <path>", "OpenClaw workspace directory for AnchorClaw import/scope")
          .option("--schema-none", "Disable dedicated schema and use default PostgreSQL search_path")
          .option("--skip-config", "Do not update ~/.openclaw/openclaw.json")
          .option("--enable-prompt-injection", "Set plugins.entries.anchorclaw.hooks.allowPromptInjection=true in openclaw.json")
          .option("--non-interactive", "Disable prompts and use defaults/flags only")
          .action(async (opts: {
            adminUrl?: string;
            dbName?: string;
            dbUser?: string;
            dbPassword?: string;
            rotateDbPassword?: boolean;
            schema?: string;
            workspaceDir?: string;
            schemaNone?: boolean;
            skipConfig?: boolean;
            enablePromptInjection?: boolean;
            nonInteractive?: boolean;
          }) => {
            await runAnchorClawSetup({
              adminUrl: opts.adminUrl,
              dbName: opts.dbName,
              dbUser: opts.dbUser,
              dbPassword: opts.dbPassword,
              rotateDbPassword: opts.rotateDbPassword,
              schema: opts.schema,
              workspaceDir: opts.workspaceDir,
              schemaNone: opts.schemaNone,
              skipConfig: opts.skipConfig,
              enablePromptInjection: opts.enablePromptInjection,
              nonInteractive: opts.nonInteractive,
            });
          });
        anchorclaw
          .command("import")
          .description("Scan or migrate legacy MEMORY.md and memory/YYYY-MM-DD.md files into AnchorClaw DB storage")
          .option("--workspace-dir <path>", "Override AnchorClaw workspace directory from plugin config")
          .option("--apply", "Import and archive active legacy files")
          .option("--keep-files", "Do not stub/archive legacy files after import")
          .action(async (opts: {
            workspaceDir?: string;
            apply?: boolean;
            keepFiles?: boolean;
          }) => {
            await runAnchorClawImport(api, {
              workspaceDir: opts.workspaceDir,
              apply: opts.apply,
              keepFiles: opts.keepFiles,
            });
          });
      }, { commands: ["anchorclaw"] });
    }

    const selectedMemorySlot =
      typeof api.runtime?.config?.current === "function"
        ? (api.runtime.config.current() as any)?.plugins?.slots?.memory
        : undefined;
    if (selectedMemorySlot !== "anchorclaw") {
      api.logger.info(
        `anchorclaw: installed but not active (plugins.slots.memory=${JSON.stringify(selectedMemorySlot)})`,
      );
      return;
    }

    let cfg: AnchorClawConfig | undefined;
    let disabledReason: string | undefined;
    try {
      cfg = anchorClawConfigSchema.parse(api.pluginConfig);
    } catch (error) {
      disabledReason = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: disabled until configured (${disabledReason})`);
    }
    if (cfg) {
      const warning = getIdentityStartupWarning(cfg);
      if (warning) {
        api.logger.warn(warning);
      }
    }

    const ctx: PluginRuntimeContext = createPluginRuntimeContext({
      api,
      cfg,
      disabledReason,
    });
    const { refreshPromptCache } = createPromptCacheRuntime({ api, ctx });
    const { ensureSessionsIndexBootstrapped, ensureSessionDeltaListener, cleanupSessionDelta } =
      createSessionDeltaRuntime({ api, ctx });
    const { cleanupMaintenance } = createMaintenanceRuntime({ api, ctx });

    api.logger.info(
      ctx.cfg
        ? `anchorclaw: plugin registered (db: ${ctx.cfg.postgres.host}, lazy init)`
        : "anchorclaw: plugin registered (disabled until configured)",
    );

    if (ctx.cfg) {
      const importCfg = ctx.cfg;
      (async () => {
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
          const workspaceDir = resolveConfiguredWorkspaceDir(importCfg);
          if (!workspaceDir) {
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
              workspaceDir,
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
          if (!workspaceDir) {
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.setDurableState({
            overall: "ready",
            import: "not_needed",
            cleanup: "not_needed",
            reason: `legacy_import_scan_failed: ${message}`,
          });
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
      })();
    }
    registerSessionDeltaLifecycle({ api, cleanupSessionDelta });
    registerMaintenanceLifecycle({ api, cleanupMaintenance });
    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
    });
    registerAnchorClawSystemOverrideHook({ api, ctx });
    registerDailyPromptHook({ api, ctx });
    registerAnchorClawFlushInboxHook({ api, ctx });
    registerAnchorClawSessionCaptureHook({ api, ctx });
    registerAnchorClawTools({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
    });
  },
});
