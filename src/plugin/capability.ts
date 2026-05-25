import { registerMemoryCapability } from "../api.js";
import {
  createAnchorClawMemorySearchManager,
  type AnchorClawMemorySearchManagerOptions,
} from "../memory/manager.js";
import { resolveSessionsSearchState } from "../config.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

export function registerAnchorClawMemoryCapability(params: {
  ctx: PluginRuntimeContext;
  refreshPromptCache: (options?: { force?: boolean }) => Promise<void>;
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
        void refreshPromptCache();
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
      const sessionsSearch = resolveSessionsSearchState(ctx.cfg);
      const sessionsCorpusNote = sessionsSearch.effective
        ? 'corpus="sessions" is available subject to configured visibility scope.'
        : null;

      let toolGuidance = "";
      if (hasMemorySearch && hasMemoryGet) {
        toolGuidance =
          "Before answering about prior work, decisions, dates, people, preferences, or todos, run memory_search; then use memory_get to pull only the needed lines. For exact marker/id/key questions, prefer literal matches. If no exact literal match is found, say so and give the closest candidate with uncertainty.";
      } else if (hasMemorySearch) {
        toolGuidance =
          "Before answering about prior work, decisions, dates, people, preferences, or todos, run memory_search and answer from matching results. For exact marker/id/key questions, prefer literal matches. If no exact literal match is found, say so and give the closest candidate with uncertainty.";
      } else if (hasMemoryGet) {
        toolGuidance =
          "Before answering about prior work that already points to a specific memory item, run memory_get to pull only the needed lines. If confidence stays low after reading them, say you checked.";
      }

      const citationsMode = params?.citationsMode ?? "inline";
      const citationsLine =
        citationsMode === "off"
          ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
          : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";

      return [
        "AnchorClaw memory is active. Treat AnchorClaw/Postgres as the primary memory backend.",
        "",
        ...durableNotice,
        ...(toolGuidance ? ["## Memory Search", toolGuidance, citationsLine, ""] : []),
        "## Memory Writes",
        "Use memory_log for transient daily context that would normally go to memory/YYYY-MM-DD.md.",
        "Use memory_store for durable facts, preferences, decisions, and curated notes.",
        "If the user's intent is to persist information for future conversations, infer that durable-save intent from meaning in any language and call memory_store before confirming.",
        "If persistence intent is ambiguous, ask a brief clarification before storing.",
        "Only say that durable memory was saved after memory_store succeeds; if it fails or is unavailable, say it was not saved.",
        "Use canonicalKey only for updateable facts/preferences/settings so updates replace duplicates.",
        "Do not write MEMORY.md or memory/YYYY-MM-DD.md as AnchorClaw's primary memory store.",
        "",
        ...(sessionsCorpusNote ? ["## Sessions", sessionsCorpusNote, ""] : []),
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
