import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { appendDailyEntryDb, resolveDailyLogicalDate } from "../../memory/daily.js";
import { resolveConfiguredWorkspaceDir, WORKSPACE_DIR_UNAVAILABLE } from "../../workspace.js";
import { getToolUnavailableResponse, type ToolRegistrationParams } from "./common.js";

function resolveRuntimeTimezone(api: any): string | undefined {
  const currentConfig =
    typeof api?.runtime?.config?.current === "function" ? api.runtime.config.current() : undefined;
  const raw = currentConfig?.agents?.defaults?.userTimezone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

export function registerMemoryLogTool({ ctx }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_log",
    label: "Memory Log",
    description:
      "Append transient daily context into AnchorClaw's DB-backed canonical daily memory.\n\nMVP rules:\n- Use this for current-day/current-conversation context, events, meeting notes, and temporary daily notes that would normally go to memory/YYYY-MM-DD.md.\n- Use memory_store instead for durable facts, preferences, recurring schedules, decisions, settings, project rules, and curated long-term notes.\n- Infer daily write intent from meaning in any language, especially when the information is about today, now, this conversation, or a current event.\n- Writes are append-only into the canonical daily entry for the resolved day.\n- Do not tell the user daily memory was saved until this tool succeeds.",
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
      const unavailable = getToolUnavailableResponse(ctx);
      if (unavailable) return unavailable;
      await ctx.ensureReady();
      const workspaceDir = resolveConfiguredWorkspaceDir(ctx.cfg);
      if (!workspaceDir) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_log unavailable (${WORKSPACE_DIR_UNAVAILABLE})` }],
          details: { disabled: true, error: WORKSPACE_DIR_UNAVAILABLE },
        };
      }

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
        workspaceDir,
        agentId: (api as any)?.runtime?.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });

      let logicalDate: string;
      try {
        logicalDate = resolveDailyLogicalDate({
          explicitDate,
          timezone: resolveRuntimeTimezone(api),
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
          runtimeAgentId: (api as any)?.runtime?.agentId ?? "main",
          sessionKey: (api as any)?.runtime?.sessionKey ?? null,
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
  });
}
