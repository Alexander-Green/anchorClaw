import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { memoryRecallDb } from "../../memory/recall.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";
import { buildSearchLikeDetailsEnvelope, formatSearchLikeVisibleOutput } from "./memory-visible-output.js";

function normalizeExact(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function classifyQueryMode(query: string): "exact_value" | "contextual" {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return "contextual";
  }
  const broadSignals = [
    "summarize",
    "summary",
    "overview",
    "around",
    "what values",
    "какие",
    "кратко",
    "обзор",
    "сгруппируй",
    "вокруг",
  ];
  if (broadSignals.some((signal) => normalized.includes(signal))) {
    return "contextual";
  }
  const exactSignals = [
    "exact",
    "top-1",
    "only",
    "value only",
    "string only",
    "id",
    "key",
    "marker",
    "token",
    "uuid",
    "login",
    "точн",
    "только",
    "значени",
  ];
  return exactSignals.some((signal) => normalized.includes(signal)) ? "exact_value" : "contextual";
}

function isMarkerLike(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+){2,}$/.test(text)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    return true;
  }
  if (/^@\w{3,}$/.test(text)) {
    return true;
  }
  return /^[0-9]{6,}$/.test(text);
}

function markerBoostForHit(hit: any): number {
  const title = typeof hit?.title === "string" ? hit.title : "";
  const snippet = typeof hit?.snippet === "string" ? hit.snippet : "";
  return isMarkerLike(title) || isMarkerLike(snippet) ? 2 : 0;
}

export function registerMemoryRecallTool({ ctx, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Recall long-term memory from Postgres.\n\nBehavior contract:\n- If query is non-empty, this is a shortcut to the same lexical FTS path as memory_search over durable memory.\n- If query is empty, returns top important recent durable items ordered by importance/recency.\n- Empty-query recall is broad recent-context recall and should not be used as evidence for exact marker/id/key lookup.\n- If the top result is an exact literal match, content includes \"Top exact match: <value>\" and details.meta.exactTop1/exactTop1Value.\n- Do not describe this tool as vector/embedding semantic retrieval unless details.meta explicitly says so in a future implementation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Optional query. If provided, AnchorClaw behaves like memory_search. If empty, returns broad recent-context items (not for exact marker/id/key lookup).",
        },
        maxResults: { type: "number", description: "Max results (capped by configured limits)." },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      const unavailable = await ensureToolRuntimeReady(ctx, ensureStartupBootstrap);
      if (unavailable) return unavailable;
      await ctx.ensureReady();
      const workspaceTarget = resolveRuntimeToolWorkspace({ ctx });
      if ("content" in workspaceTarget) return workspaceTarget;
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: workspaceTarget.workspaceDir,
        agentId: workspaceTarget.agentId,
        sessionKey: workspaceTarget.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });
      const limits = resolveMemoryLimits(ctx.cfg!);
      const recalled = await memoryRecallDb({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        limits,
        input: params,
      });

      if (!recalled.ok) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_recall failed (${recalled.error})` }],
          details: recalled,
        };
      }

      const query = typeof (params as any)?.query === "string" ? String((params as any).query) : "";
      const normalizedQuery = normalizeExact(query);
      const queryMode = classifyQueryMode(query);
      const rerankedResults = [...recalled.results];
      if (queryMode === "exact_value") {
        rerankedResults.sort((left: any, right: any) => {
          const ls = (typeof left?.score === "number" ? left.score : 0) + markerBoostForHit(left);
          const rs = (typeof right?.score === "number" ? right.score : 0) + markerBoostForHit(right);
          if (rs !== ls) {
            return rs - ls;
          }
          const lp = typeof left?.path === "string" ? left.path : "";
          const rp = typeof right?.path === "string" ? right.path : "";
          return lp.localeCompare(rp);
        });
      }
      const topHit = rerankedResults[0] as any;
      const topTitle = normalizeExact(topHit?.title);
      const topSnippet = normalizeExact(topHit?.snippet);
      const exactTop1 = Boolean(
        normalizedQuery &&
          topHit &&
          (topTitle === normalizedQuery || topSnippet === normalizedQuery),
      );
      const exactTop1Value = exactTop1
        ? (typeof topHit?.title === "string" && topHit.title.trim()) ||
          (typeof topHit?.snippet === "string" && topHit.snippet.trim()) ||
          null
        : null;
      const recommendedAction = exactTop1 ? "return_exact" : recalled.count > 0 ? "inspect_top" : "stop_not_found";
      const broadContext = normalizedQuery.length === 0;
      const visible = formatSearchLikeVisibleOutput({
        hits: rerankedResults as any[],
        retrievalMode: recalled.retrievalMode,
        queryMode,
        exactTop1,
        exactTop1Value,
        recommendedAction,
        provider: "anchorclaw",
        model: "postgres-fts",
        broadContext,
      });
      const visibleDetails = buildSearchLikeDetailsEnvelope({
        hits: rerankedResults as any[],
        retrievalMode: recalled.retrievalMode,
        queryMode,
        exactTop1,
        exactTop1Value,
        recommendedAction,
        provider: "anchorclaw",
        model: "postgres-fts",
        broadContext,
      });

      return {
        content: [
          {
            type: "text",
            text: visible,
          },
        ],
        details: {
          ...recalled,
          visible: visibleDetails,
          results: rerankedResults,
          meta: {
            retrievalMode: recalled.retrievalMode,
            queryMode,
            semantic: false,
            exactTop1,
            exactTop1Value,
            recommendedAction,
          },
        },
      };
    },
  });
}
