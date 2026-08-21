import { registerMemoryCapability } from "../api.js";
import {
  createAnchorClawMemorySearchManager,
  type AnchorClawMemorySearchManagerOptions,
} from "../memory/manager.js";
import { resolveSessionsSearchState } from "../config.js";
import { createFlushInboxPlanResolver } from "./flush-inbox.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import type { SessionIndexBootstrapTarget } from "./session-delta.js";
import { resolveSessionSearchMode } from "./session-search-mode.js";
import {
  formatConversationAccessRemedy,
  resolveConversationAccessState,
} from "./conversation-access.js";

export function registerAnchorClawMemoryCapability(params: {
  ctx: PluginRuntimeContext;
  ensureSessionsIndexBootstrapped: (target?: SessionIndexBootstrapTarget) => Promise<void>;
}) {
  const { ctx, ensureSessionsIndexBootstrapped } = params;
  const api = ctx.api;
  const timezone =
    typeof api?.runtime?.config?.current === "function"
      ? (api.runtime.config.current() as any)?.agents?.defaults?.userTimezone
      : undefined;

  registerMemoryCapability("anchorclaw", {
    promptBuilder: (params?: { availableTools: Set<string>; citationsMode?: "off" | "inline" | "block" | string }) => {
      if (ctx.disabledReason) {
        return [`AnchorClaw memory is disabled until configured (${ctx.disabledReason}).`];
      }

      const durableState = ctx.durableState ?? {
        overall: "ready",
        database: "ready",
        migrations: "ready",
        import: "ready",
        cleanup: "not_needed",
        reason: null,
      };

      // Memory capabilities are not gated by hooks.allowConversationAccess, so this notice
      // still reaches the agent on hosts where that gate has silently killed the
      // before_prompt_build injection. It is the only channel left in that state.
      const conversationAccessNotice = resolveConversationAccessState(api).blocked
        ? [
            "[AnchorClaw long-term memory is NOT being injected into this prompt: the OpenClaw host blocked its before_prompt_build hook.]",
            "Durable and daily memory are unavailable this turn even though the plugin is installed and healthy.",
            `Tell the user how to fix it if memory comes up: ${formatConversationAccessRemedy()}`,
            "Use memory_search and memory_get to retrieve memory explicitly until it is fixed.",
            "",
          ]
        : [];

      const sdkNotice = ctx.sdkHealth.degraded
        ? [
            `[AnchorClaw sessions SDK is degraded: ${ctx.sdkHealth.reason ?? "unknown error"}; operation=${ctx.sdkHealth.affectedOperation ?? "unknown"}]`,
            "",
              ]
            : [];
      const durableNotice =
        durableState.overall === "pending" || durableState.overall === "blocked"
          ? [
              "[AnchorClaw durable memory is currently unavailable or incomplete.]",
              "Do not treat missing results from MEMORY.md, USER.md, or workspace fallback files as proof that no memory exists.",
              "If the user asks about remembered facts, say that durable memory is unavailable and avoid claiming that no record exists.",
              "",
            ]
          : durableState.overall === "degraded" && durableState.cleanup === "failed"
            ? [
                `[AnchorClaw durable memory imported successfully, but legacy MEMORY.md cleanup failed${durableState.reason ? `: ${durableState.reason}` : ""}]`,
                "OpenClaw may still inject the legacy MEMORY.md separately, so duplicate memory context may be present until cleanup is resolved.",
                "",
              ]
            : [];

      const hasMemorySearch = Boolean(params?.availableTools?.has?.("memory_search"));
      const hasMemoryGet = Boolean(params?.availableTools?.has?.("memory_get"));
      const sessionsSearch = resolveSessionsSearchState(ctx.cfg);
      const sessionSearchMode = resolveSessionSearchMode(api);
      const hasNativeSessionsSearch = Boolean(params?.availableTools?.has?.("sessions_search"));
      const sessionsCorpusNote =
        sessionSearchMode === "native-openclaw"
          ? hasNativeSessionsSearch
            ? "Use sessions_search for exact recall from past OpenClaw conversations; use sessions_history for surrounding context."
            : null
          : sessionsSearch.effective
            ? 'corpus="sessions" is available subject to configured visibility scope.'
            : null;

      let toolGuidance = "";
      if (hasMemorySearch && hasMemoryGet) {
        toolGuidance =
          "Use memory_search before memory-based answers and memory_get for returned paths or exact file-like lookups. Prefer literal matches for marker/id/key questions; if no exact match exists, say so and give the closest candidate with uncertainty. If a direct durable fact hit answers the question, answer with it plainly.";
      } else if (hasMemorySearch) {
        toolGuidance =
          "Use memory_search before memory-based answers. Prefer literal matches for marker/id/key questions; if no exact match exists, say so and give the closest candidate with uncertainty. If a direct durable fact hit answers the question, answer with it plainly.";
      } else if (hasMemoryGet) {
        toolGuidance =
          "Use memory_get for specific memory paths and file-like lookups. If confidence stays low after reading them, say you checked.";
      }

      const citationsMode = params?.citationsMode ?? "inline";
      const citationsLine =
        citationsMode === "off"
          ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
          : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";

      return [
        "AnchorClaw memory is active. Treat AnchorClaw/Postgres as the primary memory backend.",
        "",
        ...conversationAccessNotice,
        ...durableNotice,
        ...(toolGuidance ? ["## Memory Search", toolGuidance, citationsLine, ""] : []),
        "## Memory Writes",
        "A save request means the user wants information preserved beyond this reply.",
        "Call exactly one write tool before final text: memory_store for durable facts, preferences, recurring schedules, decisions, settings, project rules, and curated notes; memory_log for today, now, current conversation, events, meeting notes, and temporary notes.",
        "When writing durable facts about the current user or named people, make the content self-contained and explicit about the subject instead of saving a fragment or bare value.",
        "If lifetime is unclear, ask one brief clarification instead of writing.",
        "Never say saved, remembered, or recorded unless the write tool returned success.",
        "Use canonicalKey only for updateable durable facts, preferences, schedules, or settings.",
        "",
        ...(sessionsCorpusNote ? ["## Sessions", sessionsCorpusNote, ""] : []),
        ...sdkNotice,
      ];
    },
    runtime: {
      async getMemorySearchManager(params: { cfg: any; agentId: string; purpose?: "default" | "status" | "cli" }) {
        if (ctx.disabledReason) {
          return {
            manager: null,
            error: `anchorclaw: disabled until configured (${ctx.disabledReason})`,
          };
        }
        ctx.getPool();
        return {
          manager: createAnchorClawMemorySearchManager(({
            api,
            cfg: ctx.cfg!,
            ensureReady: ctx.ensureReady,
            ensureSessionsIndexBootstrapped,
            getPool: ctx.getPool,
            agentId: params.agentId,
            purpose: params.purpose,
          } satisfies AnchorClawMemorySearchManagerOptions)),
        };
      },
      resolveMemoryBackendConfig(_params: { cfg: any; agentId: string }) {
        return { backend: "builtin" as const };
      },
    },
    flushPlanResolver: createFlushInboxPlanResolver({
      timezone: typeof timezone === "string" && timezone.trim() ? timezone.trim() : undefined,
    }),
  });
}
