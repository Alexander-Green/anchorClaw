import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { memoryStoreDb } from "../../memory/store.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";

export function registerMemoryStoreTool({ ctx, invalidatePromptMemory, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_store",
    label: "Memory Store",
    description:
      "Store durable long-term memory in Postgres. This is the DB-backed implementation for curated MEMORY.md writes. Use for save requests about stable facts, preferences, recurring schedules, decisions, settings, project rules, and curated notes. Use memory_log for daily/current context. Required: content. Use canonicalKey for updateable durable facts/preferences/schedules/settings. Optional type: fact or note. Do not confirm saved until this tool succeeds.",
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
      const unavailable = await ensureToolRuntimeReady(ctx, ensureStartupBootstrap);
      if (unavailable) return unavailable;
      await ctx.ensureReady();
      const workspaceTarget = resolveRuntimeToolWorkspace({
        ctx,
        runtimeConfig: toolCtx.runtimeConfig,
        getRuntimeConfig: toolCtx.getRuntimeConfig,
        workspaceDir: toolCtx.workspaceDir,
        agentId: toolCtx.agentId,
        sessionKey: toolCtx.sessionKey,
        sessionId: toolCtx.sessionId,
      });
      if ("content" in workspaceTarget) return workspaceTarget;
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: workspaceTarget.workspaceDir,
        agentId: workspaceTarget.agentId,
        sessionKey: workspaceTarget.sessionKey,
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

      invalidatePromptMemory({ workspaceDir: workspaceTarget.workspaceDir });

      const visible = {
        ok: true,
        path: stored.path,
        id: stored.id,
        canonicalKey: canonicalKey ?? null,
        type: type ?? null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
        details: stored,
      };
    },
  }), { name: "memory_store" });
}
