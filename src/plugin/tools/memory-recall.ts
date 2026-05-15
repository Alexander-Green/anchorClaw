import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { memoryRecallDb } from "../../memory/recall.js";
import type { ToolRegistrationParams } from "./common.js";

export function registerMemoryRecallTool({ ctx }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description: "Recall relevant long-term memory from Postgres (shortcut).",
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

      return {
        content: [
          {
            type: "text",
            text: recalled.count ? `Recalled ${recalled.count} item(s).` : "No recalled items.",
          },
        ],
        details: recalled,
      };
    },
  });
}
