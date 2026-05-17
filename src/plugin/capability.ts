import { registerMemoryCapability } from "../api.js";
import {
  createAnchorClawMemorySearchManager,
  type AnchorClawMemorySearchManagerOptions,
} from "../memory/manager.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

export function registerAnchorClawMemoryCapability(params: {
  ctx: PluginRuntimeContext;
  refreshPromptCache: () => void;
  ensureSessionsIndexBootstrapped: () => Promise<void>;
}) {
  const { ctx, refreshPromptCache, ensureSessionsIndexBootstrapped } = params;
  const api = ctx.api;

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

      if (!ctx.promptCache.lines && !ctx.promptCache.error) {
        refreshPromptCache();
      }
      const cached = ctx.promptCache.lines ?? [];
      const cacheNotice = ctx.promptCache.error
        ? [`[AnchorClaw durable memory cache unavailable: ${ctx.promptCache.error}]`, ""]
        : cached.length === 0
          ? ["[AnchorClaw durable memory cache is warming up...]", ""]
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

      let toolGuidance = "";
      if (hasMemorySearch && hasMemoryGet) {
        toolGuidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search; then use memory_get to pull only the needed lines. For one exact marker/id/key value questions, prioritize literal evidence from memory_search/memory_recall. If any memory_search or memory_recall result has details.meta.exactTop1=true, return details.meta.exactTop1Value verbatim immediately; do not substitute nearby/recent markers. Never use empty memory_recall as a tie-breaker for exact lookups. If no exactTop1 is found, say you checked and give the best candidate with uncertainty. For broad agreement/policy/decision questions, use memory_search/memory_recall to gather closest evidence; if no direct agreement record is found, report not found with a brief summary of closest evidence.";
      } else if (hasMemorySearch) {
        toolGuidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search and answer from matching results. For one exact marker/id/key value questions, prioritize literal evidence from memory_search/memory_recall. If any memory_search or memory_recall result has details.meta.exactTop1=true, return details.meta.exactTop1Value verbatim immediately; do not substitute nearby/recent markers. Never use empty memory_recall as a tie-breaker for exact lookups. If no exactTop1 is found, say you checked and give the best candidate with uncertainty. For broad agreement/policy/decision questions, use memory_search/memory_recall to gather closest evidence; if no direct agreement record is found, report not found with a brief summary of closest evidence.";
      } else if (hasMemoryGet) {
        toolGuidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory item: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
      }

      const citationsMode = params?.citationsMode ?? "inline";
      const citationsLine =
        citationsMode === "off"
          ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
          : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";

      return [
        "AnchorClaw durable memory is enabled (Postgres-backed).",
        "",
        ...durableNotice,
        ...(toolGuidance ? ["## Memory Recall", toolGuidance, citationsLine, ""] : []),
        "MVP usage rules:",
        "- Save durable memory with memory_store({ content, canonicalKey?, type? }).",
        "- Use canonicalKey only for updateable facts/preferences/settings (so updates overwrite instead of duplicating).",
        "- Find memory with memory_search({ query, corpus? }).",
        "- Read items with memory_get({ lookup: \"db-memory/items/<uuid>.md\" | \"sessions/<agentId>/<file>\", fromLine?, lineCount? }).",
        "- Shortcut recall: memory_recall({ query? }) (without query returns top important recent items).",
        "- Forget items with memory_forget({ lookup }) or memory_forget({ id }).",
        "",
        "Notes:",
        "- memory_search supports corpus=\"memory\" (Postgres durable), corpus=\"sessions\" (Postgres sessions index, DB-first), and corpus=\"all\" (merge). corpus=\"wiki\" is deferred; use wiki_search/wiki_get when installed.",
        "",
        ...cacheNotice,
        ...sdkNotice,
        ...cached,
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
  });
}
