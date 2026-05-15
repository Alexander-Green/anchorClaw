import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { memoryRecallDb } from "../../memory/recall.js";
import type { ToolRegistrationParams } from "./common.js";

function normalizeExact(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function registerMemoryRecallTool({ ctx }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description:
      "Recall long-term memory from Postgres.\n\nBehavior contract:\n- If query is non-empty, this is a shortcut to the same lexical FTS path as memory_search over durable memory.\n- If query is empty, returns top important recent durable items ordered by importance/recency.\n- If the top result is an exact literal match, content includes \"Top exact match: <value>\" and details.meta.exactTop1/exactTop1Value.\n- Do not describe this tool as vector/embedding semantic retrieval unless details.meta explicitly says so in a future implementation.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description:
            "Optional query. If provided, AnchorClaw behaves like memory_search. If empty, returns top important recent durable items.",
        },
        maxResults: { type: "number", description: "Max results (capped by configured limits)." },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      if (ctx.disabledReason) {
        return {
          content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
          details: { disabled: true, error: ctx.disabledReason },
        };
      }
      await ctx.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        agentId: (api as any)?.runtime?.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
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
      const topHit = recalled.results[0] as any;
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
      const topExactLine = exactTop1 && exactTop1Value ? `\nTop exact match: ${exactTop1Value}` : "";

      return {
        content: [
          {
            type: "text",
            text: recalled.count ? `Recalled ${recalled.count} item(s).${topExactLine}` : "No recalled items.",
          },
        ],
        details: {
          ...recalled,
          meta: {
            retrievalMode: recalled.retrievalMode,
            semantic: false,
            exactTop1,
            exactTop1Value,
          },
        },
      };
    },
  });
}
