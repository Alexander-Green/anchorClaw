import type { OpenClawPluginApi } from "../api.js";
import type { OpenClawConfig as OpenClawRuntimeConfig } from "openclaw/plugin-sdk/health";
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
const DAILY_STARTUP_MAX_DAILY_ENTRIES = 4;
const DAILY_STARTUP_MAX_SESSION_CAPTURES = 4;
const PROMPT_DEBUG_PREVIEW_MAX_CHARS = 1_500;

type DailyPromptEvent = {
  messages?: unknown;
};

type DailyPromptHookContext = {
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

function asRuntimeConfig(value: unknown): OpenClawRuntimeConfig | undefined {
  return value && typeof value === "object" ? (value as OpenClawRuntimeConfig) : undefined;
}

function resolveRuntimeConfig(
  api: OpenClawPluginApi,
  hookContext?: DailyPromptHookContext,
): OpenClawRuntimeConfig | undefined {
  return asRuntimeConfig(
    hookContext?.runtimeConfig ??
    (typeof hookContext?.getRuntimeConfig === "function"
      ? hookContext.getRuntimeConfig()
      : typeof api.runtime?.config?.current === "function"
        ? api.runtime.config.current()
        : undefined)
  );
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? Math.trunc(numeric) : fallback));
}

function resolveStartupContextSettings(runtimeConfig?: OpenClawRuntimeConfig): {
  enabled: boolean;
  dailyMemoryDays: number;
  maxEntryChars: number;
  maxTotalChars: number;
} {
  const startupContext = runtimeConfig?.agents?.defaults?.startupContext;
  return {
    enabled: startupContext?.enabled !== false,
    dailyMemoryDays: clampInteger(startupContext?.dailyMemoryDays, STARTUP_DAILY_MEMORY_DAYS, 1, 14),
    maxEntryChars: clampInteger(startupContext?.maxFileChars, DAILY_STARTUP_MAX_ENTRY_CHARS, 1, 10_000),
    maxTotalChars: clampInteger(startupContext?.maxTotalChars, DAILY_STARTUP_MAX_TOTAL_CHARS, 1, 50_000),
  };
}

function resolveRuntimeTimezone(runtimeConfig?: OpenClawRuntimeConfig): string | undefined {
  const raw = runtimeConfig?.agents?.defaults?.userTimezone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function registerDailyPromptHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  ensureStartupBootstrap?: () => Promise<void>;
}) {
  const { api, ctx, ensureStartupBootstrap } = params;
  const debugPromptLogEnabled = ctx.cfg?.debug?.promptLogEnabled === true;
  const handler = async (event: DailyPromptEvent, hookContext?: DailyPromptHookContext) => {
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

    const runtimeConfig = resolveRuntimeConfig(api, hookContext);
    const startupContext = resolveStartupContextSettings(runtimeConfig);
    if (!startupContext.enabled) {
      if (debugPromptLogEnabled) {
        api.logger.info("anchorclaw: daily startup prompt injection disabled by startupContext");
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
        runtimeConfig,
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
          timezone: resolveRuntimeTimezone(runtimeConfig),
          dailyMemoryDays: startupContext.dailyMemoryDays,
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
        maxTotalChars: startupContext.maxTotalChars,
        maxPathChars: DAILY_STARTUP_MAX_PATH_CHARS,
        maxEntryChars: startupContext.maxEntryChars,
        maxSessionCaptureEntryChars: startupContext.maxEntryChars,
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

  if (typeof api.on !== "function") {
    return;
  }

  api.on("before_prompt_build", handler, {
    name: "anchorclaw-daily-startup-injection",
  });
  if (debugPromptLogEnabled) {
    api.logger.info("anchorclaw: daily startup prompt hook registered (named before_prompt_build)");
  }
}
