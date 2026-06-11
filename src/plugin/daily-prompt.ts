import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import {
  buildStartupMemoryDateStamps,
  STARTUP_DAILY_MEMORY_DAYS,
  STARTUP_MAX_SLUGGED_FILES_PER_DAY,
} from "../memory/daily.js";
import { buildPromptDailySection, queryPromptDailyEntries } from "../memory/prompt.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceTarget,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";

const DAILY_STARTUP_MAX_TOTAL_CHARS = 2_800;
const DAILY_STARTUP_MAX_PATH_CHARS = 80;
const DAILY_STARTUP_MAX_ENTRY_CHARS = 1_200;
const DAILY_STARTUP_MAX_SESSION_CAPTURE_ENTRY_CHARS = 1_200;
const DAILY_STARTUP_MAX_DAILY_ENTRIES = 4;
const DAILY_STARTUP_MAX_SESSION_CAPTURES = 4;
const PROMPT_DEBUG_PREVIEW_MAX_CHARS = 1_500;

function resolveRuntimeTimezone(api: OpenClawPluginApi, hookContext?: any): string | undefined {
  const currentConfig =
    hookContext?.runtimeConfig ??
    (typeof hookContext?.getRuntimeConfig === "function"
      ? hookContext.getRuntimeConfig()
      : typeof (api as any)?.runtime?.config?.current === "function"
        ? (api as any).runtime.config.current()
        : undefined);
  const raw = (currentConfig as any)?.agents?.defaults?.userTimezone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function registerDailyPromptHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  ensureStartupBootstrap?: () => Promise<void>;
}) {
  const { api, ctx, ensureStartupBootstrap } = params;
  const debugPromptLogEnabled = ctx.cfg?.debug?.promptLogEnabled === true;
  const handler = async (event: any, hookContext?: any) => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }
    const messageCount = Array.isArray(event?.messages) ? event.messages.length : null;
    if (debugPromptLogEnabled) {
      api.logger.info(
        `anchorclaw: daily startup prompt hook invoked (messages=${messageCount === null ? "non_array" : messageCount})`,
      );
    }
    if (!Array.isArray(event?.messages) || event.messages.length > 0) {
      if (debugPromptLogEnabled) {
        api.logger.info(
          `anchorclaw: daily startup prompt injection skipped (messages=${messageCount === null ? "non_array" : messageCount})`,
        );
      }
      return undefined;
    }

    try {
      if (
        (ctx.durableState?.overall === "pending" ||
          (ctx.durableState?.overall === "blocked" &&
            ctx.durableState?.import === "failed_retryable")) &&
        typeof ensureStartupBootstrap === "function"
      ) {
        await ensureStartupBootstrap();
        if (String(ctx.durableState.overall) !== "ready") {
          return undefined;
        }
      } else {
        await ctx.ensureReady();
      }
      const workspaceTarget = resolveRuntimeWorkspaceTarget({
        api,
        runtimeConfig: hookContext?.runtimeConfig,
        getRuntimeConfig: hookContext?.getRuntimeConfig,
        workspaceDir: hookContext?.workspaceDir,
        agentId: hookContext?.agentId,
        sessionKey: hookContext?.sessionKey,
        sessionId: hookContext?.sessionId,
      });
      if (!workspaceTarget) {
        throw new Error(RUNTIME_WORKSPACE_UNAVAILABLE);
      }
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: workspaceTarget.workspaceDir,
        agentId: workspaceTarget.agentId,
        sessionKey: workspaceTarget.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });
      const entries = await queryPromptDailyEntries({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        logicalDates: buildStartupMemoryDateStamps({
          timezone: resolveRuntimeTimezone(api, hookContext),
          dailyMemoryDays: STARTUP_DAILY_MEMORY_DAYS,
        }),
        maxSluggedPerDay: STARTUP_MAX_SLUGGED_FILES_PER_DAY,
      });
      if (entries.length === 0) {
        if (debugPromptLogEnabled) {
          api.logger.info("anchorclaw: daily startup prompt injection found no eligible entries");
        }
        return undefined;
      }

      const lines = buildPromptDailySection({
        entries,
        maxTotalChars: DAILY_STARTUP_MAX_TOTAL_CHARS,
        maxPathChars: DAILY_STARTUP_MAX_PATH_CHARS,
        maxEntryChars: DAILY_STARTUP_MAX_ENTRY_CHARS,
        maxSessionCaptureEntryChars: DAILY_STARTUP_MAX_SESSION_CAPTURE_ENTRY_CHARS,
        maxDailyEntries: DAILY_STARTUP_MAX_DAILY_ENTRIES,
        maxSessionCaptures: DAILY_STARTUP_MAX_SESSION_CAPTURES,
      });
      if (lines.length === 0) {
        if (debugPromptLogEnabled) {
          api.logger.info("anchorclaw: daily startup prompt injection built an empty context block");
        }
        return undefined;
      }

      if (debugPromptLogEnabled) {
        const preview = lines.join("\n").slice(0, PROMPT_DEBUG_PREVIEW_MAX_CHARS);
        const previewSuffix = preview.length < lines.join("\n").length ? "…" : "";
        const selectedSummary = entries
          .map((entry) => `${entry.sourceKind}:${entry.path}`)
          .join(", ");
        api.logger.info(
          `anchorclaw: daily startup prompt injection applied (messages=0, selected=${entries.length}, entries=[${selectedSummary}], preview=${JSON.stringify(`${preview}${previewSuffix}`)})`,
        );
      }

      return {
        prependContext: lines.join("\n"),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: daily startup prompt injection failed (${message})`);
      return undefined;
    }
  };

  const onAny = (api as any).on;
  if (typeof onAny !== "function") {
    return;
  }

  onAny("before_prompt_build", handler, {
    name: "anchorclaw-daily-startup-injection",
  });
  if (debugPromptLogEnabled) {
    api.logger.info("anchorclaw: daily startup prompt hook registered (named before_prompt_build)");
  }
}
