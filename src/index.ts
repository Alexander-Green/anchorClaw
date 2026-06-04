import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  anchorClawConfigSchema,
  type AnchorClawConfig,
} from "./config.js";
import { getIdentityStartupWarning } from "./identity-policy.js";
import {
  createPluginRuntimeContext,
  type PluginRuntimeContext,
} from "./plugin/runtime-context.js";
import { createPromptCacheRuntime } from "./plugin/prompt-cache.js";
import { registerAnchorClawMemoryCapability } from "./plugin/capability.js";
import { registerDailyPromptHook } from "./plugin/daily-prompt.js";
import { registerAnchorClawFlushInboxHook } from "./plugin/flush-inbox.js";
import { registerAnchorClawGatewayService } from "./plugin/gateway-service.js";
import { registerSessionDeltaLifecycle } from "./plugin/lifecycle.js";
import { createMaintenanceRuntime, registerMaintenanceLifecycle } from "./plugin/maintenance.js";
import { createSessionDeltaRuntime } from "./plugin/session-delta.js";
import { createStartupBootstrapRuntime } from "./plugin/startup-bootstrap.js";
import { registerAnchorClawSessionCaptureHook } from "./plugin/session-capture.js";
import { registerAnchorClawTools } from "./plugin/tools/index.js";
import { runAnchorClawSetup } from "./scripts/setup-db.js";
import { runAnchorClawImport } from "./scripts/import-legacy.js";

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
    const { cleanupMaintenance, startMaintenance, triggerMaintenanceNow } = createMaintenanceRuntime({
      api,
      ctx,
      autostart: false,
    });
    const { ensureStartupBootstrap, kickoffStartupBootstrap } = createStartupBootstrapRuntime({
      api,
      ctx,
      refreshPromptCache,
      triggerMaintenanceNow,
      ensureSessionDeltaListener,
    });
    const maintenanceServiceRegistered = registerAnchorClawGatewayService({
      api,
      kickoffStartupBootstrap,
      startMaintenance,
      cleanupMaintenance,
    });
    if (!maintenanceServiceRegistered) {
      api.logger.warn(
        "anchorclaw: plugin service API unavailable; starting startup bootstrap and maintenance eagerly for compatibility",
      );
      kickoffStartupBootstrap();
      startMaintenance();
      registerMaintenanceLifecycle({ api, cleanupMaintenance });
    }

    api.logger.info(
      ctx.cfg
        ? `anchorclaw: plugin registered (db: ${ctx.cfg.postgres.host}, lazy init)`
        : "anchorclaw: plugin registered (disabled until configured)",
    );
    registerSessionDeltaLifecycle({ api, cleanupSessionDelta });
    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
      ensureStartupBootstrap,
    });
    registerDailyPromptHook({ api, ctx, ensureStartupBootstrap });
    registerAnchorClawFlushInboxHook({ api, ctx });
    registerAnchorClawSessionCaptureHook({ api, ctx });
    registerAnchorClawTools({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
      ensureStartupBootstrap,
    });
  },
});
