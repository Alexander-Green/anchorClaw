import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { memoryStoreDb } from "../../memory/store.js";
import type { ToolRegistrationParams } from "./common.js";

export function registerMemoryStoreTool({ ctx, refreshPromptCache }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_store",
    label: "Memory Store",
    description:
      "Store durable long-term memory into Postgres.\n\nMVP rules:\n- Always provide { content }.\n- If you are storing an updateable fact/preference/setting, provide { canonicalKey } so future calls overwrite the same logical item (instead of creating duplicates).\n- Optionally provide { type: \"fact\"|\"note\"|... } (default: \"note\").",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: { type: "string", description: "Markdown/plain text memory content" },
        canonicalKey: {
          type: "string",
          description:
            "Optional canonical key for upsert (e.g. \"timezone\", \"preferred_language\", \"project_name\"). When set, AnchorClaw updates the existing active item instead of creating duplicates.",
        },
        canonical_key: {
          type: "string",
          description: "Alias for canonicalKey.",
        },
        type: {
          type: "string",
          description: "Optional memory item type (default: note).",
          enum: ["fact", "note"],
        },
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

      const record = (params ?? {}) as any;
      const content = typeof record.content === "string" ? String(record.content) : "";
      if (!content.trim()) {
        return {
          content: [{ type: "text", text: "anchorclaw: memory_store requires non-empty content" }],
          details: { disabled: true, error: "content is required" },
        };
      }
      const canonicalKey =
        typeof record.canonicalKey === "string" && record.canonicalKey.trim()
          ? String(record.canonicalKey)
          : typeof record.canonical_key === "string" && record.canonical_key.trim()
            ? String(record.canonical_key)
            : undefined;
      const type = typeof record.type === "string" ? String(record.type) : undefined;

      const stored = await memoryStoreDb({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        actor: ctx.resolveActor(),
        logger: api.logger,
        input: { content, ...(canonicalKey ? { canonicalKey } : {}), ...(type ? { type } : {}) },
      });

      if (!stored.ok) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_store failed (${stored.error})` }],
          details: stored,
        };
      }

      refreshPromptCache();

      const visible = {
        ok: true,
        path: stored.path,
        id: stored.id,
        canonicalKey: stored.canonicalKey ?? null,
        type: stored.type ?? null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
        details: stored,
      };
    },
  });
}
