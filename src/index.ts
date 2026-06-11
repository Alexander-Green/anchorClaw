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
import { createPromptMemoryRuntime } from "./plugin/prompt-cache.js";
import { registerAnchorClawMemoryCapability } from "./plugin/capability.js";
import { registerDurablePromptHook } from "./plugin/durable-prompt.js";
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
          .option(
            "--maintenance-workspace-scope <mode>",
            'Maintenance extractor scope: "default-agent" or "all-agent-workspaces"',
          )
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
            maintenanceWorkspaceScope?: "default-agent" | "all-agent-workspaces";
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
              maintenanceWorkspaceScope: opts.maintenanceWorkspaceScope,
              schemaNone: opts.schemaNone,
              skipConfig: opts.skipConfig,
              nonInteractive: opts.nonInteractive,
            });
          });
        anchorclaw
          .command("import")
          .description("Scan or migrate legacy MEMORY.md and memory/YYYY-MM-DD.md files into AnchorClaw DB storage")
          .option("--default-agent", "Import into the OpenClaw default agent workspace")
          .option("--agent <id>", "Import into a specific configured OpenClaw agent workspace")
          .option("--all-agent-workspaces", "Import all unique agent workspaces from OpenClaw config")
          .option("--source-dir <path>", "Import legacy files from an external source directory into the selected agent workspace")
          .option("--apply", "Import and archive active legacy files")
          .option("--keep-files", "Do not stub/archive legacy files after import")
          .option("--non-interactive", "Disable prompts and require explicit flags only")
          .action(async (opts: {
            defaultAgent?: boolean;
            agent?: string;
            allAgentWorkspaces?: boolean;
            sourceDir?: string;
            apply?: boolean;
            keepFiles?: boolean;
            nonInteractive?: boolean;
          }) => {
            await runAnchorClawImport(api, {
              defaultAgent: opts.defaultAgent,
              agent: opts.agent,
              allAgentWorkspaces: opts.allAgentWorkspaces,
              sourceDir: opts.sourceDir,
              apply: opts.apply,
              keepFiles: opts.keepFiles,
              nonInteractive: opts.nonInteractive,
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
    const { getPromptMemoryLines, invalidatePromptMemory } = createPromptMemoryRuntime({ api, ctx });
    const { ensureSessionsIndexBootstrapped, ensureSessionDeltaListener, cleanupSessionDelta } =
      createSessionDeltaRuntime({ api, ctx });
    const { cleanupMaintenance, startMaintenance, triggerMaintenanceNow } = createMaintenanceRuntime({
      api,
      ctx,
      invalidatePromptMemory,
      autostart: false,
    });
    const cleanupRuntime = async () => {
      cleanupMaintenance();
      cleanupSessionDelta();
      await ctx.cleanupPool();
    };
    const { ensureStartupBootstrap, kickoffStartupBootstrap } = createStartupBootstrapRuntime({
      api,
      ctx,
      triggerMaintenanceNow,
      ensureSessionDeltaListener,
    });
    const maintenanceServiceRegistered = registerAnchorClawGatewayService({
      api,
      kickoffStartupBootstrap,
      startMaintenance,
      cleanupRuntime,
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
    registerSessionDeltaLifecycle({ api, cleanupRuntime });
    registerAnchorClawMemoryCapability({
      ctx,
      ensureSessionsIndexBootstrapped,
    });
    registerDurablePromptHook({ api, ctx, getPromptMemoryLines, ensureStartupBootstrap });
    registerDailyPromptHook({ api, ctx, ensureStartupBootstrap });
    registerAnchorClawFlushInboxHook({ api, ctx });
    registerAnchorClawSessionCaptureHook({ api, ctx });
    registerAnchorClawTools({
      ctx,
      invalidatePromptMemory,
      ensureSessionsIndexBootstrapped,
      ensureStartupBootstrap,
    });
  },
});
