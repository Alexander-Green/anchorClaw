import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { parseLogicalDateFromDailyPath } from "../memory/daily.js";
import { buildPromptDailySection, queryPromptDailyEntries } from "../memory/prompt.js";
import { requireConfiguredWorkspaceDir } from "../workspace.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

const DAILY_STARTUP_ENTRY_SCAN_LIMIT = 12;
const DAILY_STARTUP_MAX_DAYS = 2;
const DAILY_STARTUP_MAX_TOTAL_CHARS = 2_800;
const DAILY_STARTUP_MAX_PATH_CHARS = 80;
const DAILY_STARTUP_MAX_ENTRY_CHARS = 1_200;

function selectRecentDailyStartupEntries(entries: Awaited<ReturnType<typeof queryPromptDailyEntries>>): typeof entries {
  const selected: typeof entries = [];
  const seenPaths = new Set<string>();
  const seenDays = new Set<string>();

  for (const entry of entries) {
    const day = entry.logicalDate ?? parseLogicalDateFromDailyPath(entry.path);
    if (!day) {
      continue;
    }
    if (seenPaths.has(entry.path)) {
      continue;
    }
    if (!seenDays.has(day) && seenDays.size >= DAILY_STARTUP_MAX_DAYS) {
      continue;
    }
    seenPaths.add(entry.path);
    seenDays.add(day);
    selected.push(entry);
  }

  return selected;
}

export function registerDailyPromptHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}) {
  const { api, ctx } = params;
  const handler = async (event: any) => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }
    if (!Array.isArray(event?.messages) || event.messages.length > 0) {
      return undefined;
    }

    try {
      await ctx.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: requireConfiguredWorkspaceDir(ctx.cfg),
        agentId: (api as any)?.runtime?.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });
      const entries = await queryPromptDailyEntries({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        limit: DAILY_STARTUP_ENTRY_SCAN_LIMIT,
      });
      const selectedEntries = selectRecentDailyStartupEntries(entries);
      if (selectedEntries.length === 0) {
        return undefined;
      }

      const lines = buildPromptDailySection({
        entries: selectedEntries,
        maxTotalChars: DAILY_STARTUP_MAX_TOTAL_CHARS,
        maxPathChars: DAILY_STARTUP_MAX_PATH_CHARS,
        maxEntryChars: DAILY_STARTUP_MAX_ENTRY_CHARS,
      });
      if (lines.length === 0) {
        return undefined;
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

  const registerHookAny = (api as any).registerHook;
  if (typeof registerHookAny !== "function") {
    return;
  }

  // Host SDK compatibility: some builds accept object-form hook registration,
  // while older builds use registerHook(name, handler).
  try {
    registerHookAny({
      name: "anchorclaw-daily-startup-injection",
      event: "before_prompt_build",
      handler,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.debug?.(`anchorclaw: object-form hook registration failed, trying legacy signature (${message})`);
  }

  registerHookAny("before_prompt_build", handler);
}
