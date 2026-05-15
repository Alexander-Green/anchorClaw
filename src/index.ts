import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  anchorClawConfigSchema,
  type AnchorClawConfig,
} from "./config.js";
import { runOneTimeWorkspaceImport } from "./importer.js";
import { getIdentityStartupWarning } from "./identity-policy.js";
import {
  createPluginRuntimeContext,
  type PluginRuntimeContext,
} from "./plugin/runtime-context.js";
import { createPromptCacheRuntime } from "./plugin/prompt-cache.js";
import { registerAnchorClawMemoryCapability } from "./plugin/capability.js";
import { registerSessionDeltaLifecycle } from "./plugin/lifecycle.js";
import { createSessionDeltaRuntime } from "./plugin/session-delta.js";
import { registerAnchorClawTools } from "./plugin/tools/index.js";

export default definePluginEntry({
  id: "anchorclaw",
  name: "AnchorClaw",
  description: "Postgres-backed long-term memory plugin",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
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

    api.logger.info(
      ctx.cfg
        ? `anchorclaw: plugin registered (db: ${ctx.cfg.postgres.host}, lazy init)`
        : "anchorclaw: plugin registered (disabled until configured)",
    );

    // Best-effort warm-up so the very first prompt often has durable memory available.
    if (ctx.cfg) {
      refreshPromptCache();
      ensureSessionDeltaListener();
    }

    // Best-effort one-time import of legacy memory files from the workspace into Postgres.
    // This does not remove/disable file-based behavior in OpenClaw core; it only populates DB state.
    if (ctx.cfg) {
      const importCfg = ctx.cfg;
      (async () => {
        try {
          await ctx.ensureReady();
          const workspaceDir =
            typeof (api as any)?.runtime?.workspaceDir === "string" && (api as any).runtime.workspaceDir.trim()
              ? String((api as any).runtime.workspaceDir)
              : process.cwd();
          await runOneTimeWorkspaceImport({
            api,
            cfg: importCfg,
            pool: ctx.getPool(),
            workspaceDir,
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
          });
          refreshPromptCache();
        } catch (error) {
          api.logger.warn(
            `anchorclaw: workspace import failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      })();
    }
    registerSessionDeltaLifecycle({ api, cleanupSessionDelta });
    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
    });
    registerAnchorClawTools({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
    });
  },
});
