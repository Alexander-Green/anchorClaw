import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { memoryForgetDb } from "../../memory/forget.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";

export function registerMemoryForgetTool({ ctx, invalidatePromptMemory, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Soft-delete a durable memory item stored in AnchorClaw/Postgres.\n\nRules:\n- Prefer passing lookup=db-memory/items/<uuid>.md (from memory_search or memory_store).\n- Alternatively pass id=<uuid>.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        lookup: {
          type: "string",
          description:
            "Synthetic DB memory path, e.g. db-memory/items/<uuid>.md (preferred).",
        },
        path: {
          type: "string",
          description: "Alias for lookup (OpenClaw-style).",
        },
        id: { type: "string", description: "Memory item UUID (alternative to lookup)." },
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
      const lookup =
        typeof record.lookup === "string" && record.lookup.trim()
          ? String(record.lookup)
          : typeof record.path === "string" && record.path.trim()
            ? String(record.path)
            : undefined;
      const id = typeof record.id === "string" && record.id.trim() ? String(record.id) : undefined;
      if (!lookup && !id) {
        return {
          content: [{ type: "text", text: "anchorclaw: memory_forget requires lookup/path or id" }],
          details: { disabled: true, error: "lookup or id required" },
        };
      }

      const forgot = await memoryForgetDb({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        actor: ctx.resolveActor(),
        logger: api.logger,
        input: { ...(lookup ? { lookup } : {}), ...(id ? { id } : {}) },
      });

      if (!forgot.ok) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_forget failed (${forgot.error})` }],
          details: forgot,
        };
      }

      invalidatePromptMemory({ workspaceDir: workspaceTarget.workspaceDir });

      const visible = {
        ok: true,
        deleted: forgot.deleted,
        lookup: lookup ?? null,
        id: id ?? null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
        details: forgot,
      };
    },
  }), { name: "memory_forget" });
}
