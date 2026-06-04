import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { memoryForgetDb } from "../../memory/forget.js";
import { resolveConfiguredWorkspaceDir, WORKSPACE_DIR_UNAVAILABLE } from "../../workspace.js";
import { ensureToolRuntimeReady, type ToolRegistrationParams } from "./common.js";

export function registerMemoryForgetTool({ ctx, refreshPromptCache, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description:
      "Soft-delete a durable memory item stored in AnchorClaw/Postgres.\n\nMVP rules:\n- Prefer passing lookup=db-memory/items/<uuid>.md (from memory_search or memory_store).\n- Alternatively pass id=<uuid>.",
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
      const workspaceDir = resolveConfiguredWorkspaceDir(ctx.cfg);
      if (!workspaceDir) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_forget unavailable (${WORKSPACE_DIR_UNAVAILABLE})` }],
          details: { disabled: true, error: WORKSPACE_DIR_UNAVAILABLE },
        };
      }
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir,
        agentId: (api as any)?.runtime?.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
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

      await refreshPromptCache({ force: true });

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
  });
}
