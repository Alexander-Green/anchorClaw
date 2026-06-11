import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { appendDailyEntryDb, resolveDailyLogicalDate } from "../../memory/daily.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";

function resolveRuntimeTimezone(api: any, toolCtx: OpenClawPluginToolContext): string | undefined {
  const toolConfig =
    toolCtx.runtimeConfig ??
    (typeof toolCtx.getRuntimeConfig === "function" ? toolCtx.getRuntimeConfig() : undefined);
  const toolRaw = toolConfig?.agents?.defaults?.userTimezone;
  if (typeof toolRaw === "string" && toolRaw.trim()) return toolRaw.trim();

  const currentConfig =
    typeof api?.runtime?.config?.current === "function" ? api.runtime.config.current() : undefined;
  const raw = currentConfig?.agents?.defaults?.userTimezone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function registerMemoryLogTool({ ctx, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_log",
    label: "Memory Log",
    description:
      "Append DB-backed daily/current memory. This is the DB-backed implementation for memory/YYYY-MM-DD.md appends. Use for save requests about today, now, current conversation, events, meeting notes, and temporary notes. Use memory_store for durable facts, preferences, schedules, decisions, settings, project rules, and curated notes. Required: content. Optional: date or memory/YYYY-MM-DD.md path. Do not confirm logged until this tool succeeds.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          type: "string",
          description: "Daily note content to append.",
        },
        date: {
          type: "string",
          description: "Optional logical date in YYYY-MM-DD. Defaults to the user's current day.",
        },
        path: {
          type: "string",
          description: "Optional OpenClaw-style daily path alias, e.g. memory/2026-05-20.md.",
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

      const record = (params ?? {}) as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content : "";
      if (!content.trim()) {
        return {
          content: [{ type: "text", text: "anchorclaw: memory_log requires non-empty content" }],
          details: { disabled: true, error: "content is required" },
        };
      }

      let explicitDate: string | undefined;
      if (typeof record.date === "string" && record.date.trim()) {
        explicitDate = record.date.trim();
      } else if (typeof record.path === "string" && record.path.trim()) {
        const match = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(record.path.trim());
        if (!match) {
          return {
            content: [{ type: "text", text: "anchorclaw: memory_log path must look like memory/YYYY-MM-DD.md" }],
            details: { disabled: true, error: "invalid daily path" },
          };
        }
        explicitDate = match[1];
      }

      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: workspaceTarget.workspaceDir,
        agentId: workspaceTarget.agentId,
        sessionKey: workspaceTarget.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });

      let logicalDate: string;
      try {
        logicalDate = resolveDailyLogicalDate({
          explicitDate,
          timezone: resolveRuntimeTimezone(api, toolCtx),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `anchorclaw: memory_log failed (${message})` }],
          details: { disabled: true, error: message },
        };
      }

      const stored = await appendDailyEntryDb({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        actor: ctx.resolveActor(),
        logger: api.logger,
        logicalDate,
        content,
        sourceKind: "memory_log",
        metadata: {
          tool: "memory_log",
          runtimeAgentId: workspaceTarget.agentId,
          sessionKey: workspaceTarget.sessionKey ?? null,
        },
      });

      if (!stored.ok) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_log failed (${stored.error})` }],
          details: stored,
        };
      }

      const visible = {
        ok: true,
        path: stored.path,
        id: stored.id,
        logicalDate: stored.logicalDate,
        created: stored.created,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(visible, null, 2) }],
        details: stored,
      };
    },
  }), { name: "memory_log" });
}
