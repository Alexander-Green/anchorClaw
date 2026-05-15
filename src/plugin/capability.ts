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

      const hasMemorySearch = Boolean(params?.availableTools?.has?.("memory_search"));
      const hasMemoryGet = Boolean(params?.availableTools?.has?.("memory_get"));

      let toolGuidance = "";
      if (hasMemorySearch && hasMemoryGet) {
        toolGuidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
      } else if (hasMemorySearch) {
        toolGuidance =
          "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search and answer from matching results. If low confidence after search, say you checked.";
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
