import type { OpenClawPluginApi } from "../api.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import { resolveConfiguredWorkspaceDir } from "../workspace.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import {
  MAINTENANCE_INTERNAL_MARKER,
  MAINTENANCE_SESSION_ID_PREFIX,
} from "../maintenance/constants.js";

// Keep headroom below the default extractor window so one row can fit with its prefix.
const MAX_EPISODIC_CONTENT_CHARS = 11_000;
const MAX_TRACKED_TOOL_CALLS = 1_000;

function extractText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

function truncateText(value: string, maxChars = MAX_EPISODIC_CONTENT_CHARS) {
  if (value.length <= maxChars) {
    return { text: value, truncated: false, originalLength: value.length };
  }
  return {
    text: value.slice(0, maxChars).trimEnd(),
    truncated: true,
    originalLength: value.length,
  };
}

function sanitizeUserPrompt(value: string): string {
  return value
    .replace(/\[SYSTEM RAG CONTEXT\][\s\S]*?\[END CONTEXT\]\s*/g, "")
    .replace(/^\[.*?\]\s*/, "")
    .trim();
}

function stringifyToolArgs(event: any, call?: any): string {
  const raw =
    event?.params !== undefined
      ? event.params
      : event?.args !== undefined
        ? event.args
        : call?.function?.arguments !== undefined
          ? call.function.arguments
          : {};
  if (typeof raw === "string") {
    return raw;
  }
  try {
    return JSON.stringify(raw ?? {});
  } catch {
    return String(raw);
  }
}

function isMemoryStoreTool(toolName: string): boolean {
  return toolName === "memory_store" || toolName.endsWith(".memory_store");
}

function isInternalProvider(value: unknown): boolean {
  return value === "heartbeat" || value === "cron";
}

function isMaintenanceSession(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MAINTENANCE_SESSION_ID_PREFIX);
}

function shouldSkipHook(hookCtx: any): boolean {
  return isInternalProvider(hookCtx?.messageProvider) || isMaintenanceSession(hookCtx?.sessionId);
}

function toolCallKey(toolCallId: string, toolName: string, args: string): string {
  return toolCallId || `${toolName}:${args.slice(0, 500)}`;
}

function markBounded(set: Set<string>, value: string) {
  if (!value) {
    return;
  }
  set.add(value);
  while (set.size > MAX_TRACKED_TOOL_CALLS) {
    const first = set.values().next().value;
    if (!first) {
      break;
    }
    set.delete(first);
  }
}

function setBounded(map: Map<string, string>, key: string, value: string) {
  if (!key || !value) {
    return;
  }
  map.set(key, value);
  while (map.size > MAX_TRACKED_TOOL_CALLS) {
    const first = map.keys().next().value;
    if (!first) {
      break;
    }
    map.delete(first);
  }
}

export function registerEpisodicHooks(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}) {
  const { api, ctx } = params;
  const on = (api as any)?.on;
  if (typeof on !== "function") {
    return;
  }

  const toolCallNames = new Map<string, string>();
  const loggedToolCallKeys = new Set<string>();

  async function insertEvent(params: {
    eventType: string;
    content: string;
    metadata?: Record<string, unknown>;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
  }) {
    const workspaceDir = resolveConfiguredWorkspaceDir(ctx.cfg);
    const content = truncateText(params.content.trim());
    if (!workspaceDir || !content.text) {
      return;
    }
    try {
      await ctx.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir,
        agentId: params.agentId ?? (api as any)?.runtime?.agentId,
        sessionKey: params.sessionKey ?? (api as any)?.runtime?.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });
      await ctx.getPool().query(
        `
        INSERT INTO memory_episodic (
          user_id, workspace_id, agent_id, session_key, session_id, event_type, content, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          scope.userId,
          scope.workspaceId,
          params.agentId ?? String((api as any)?.runtime?.agentId ?? "main"),
          params.sessionKey ?? (api as any)?.runtime?.sessionKey ?? null,
          params.sessionId ?? (api as any)?.runtime?.sessionId ?? null,
          params.eventType,
          content.text,
          JSON.stringify({
            ...(params.metadata ?? {}),
            ...(content.truncated
              ? { truncated: true, originalLength: content.originalLength }
              : {}),
          }),
        ],
      );
    } catch (error) {
      api.logger.warn(
        `anchorclaw: episodic log failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  on("before_tool_call", async (event: any, hookCtx: any) => {
    if (shouldSkipHook(hookCtx)) {
      return;
    }
    const toolName =
      typeof event?.toolName === "string"
        ? event.toolName
        : typeof event?.tool?.name === "string"
          ? event.tool.name
          : "";
    const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
    if (toolCallId && toolName) {
      setBounded(toolCallNames, toolCallId, toolName);
    }
  });

  on("after_tool_call", async (event: any, hookCtx: any) => {
    if (shouldSkipHook(hookCtx)) {
      return;
    }
    const toolName =
      typeof event?.toolName === "string"
        ? event.toolName
        : typeof event?.tool?.name === "string"
          ? event.tool.name
          : "";
    const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
    if (!toolName || isMemoryStoreTool(toolName)) {
      return;
    }
    const args = stringifyToolArgs(event);
    if (args.includes(MAINTENANCE_INTERNAL_MARKER)) {
      return;
    }
    const key = toolCallKey(toolCallId, toolName, args);
    if (loggedToolCallKeys.has(key)) {
      return;
    }
    await insertEvent({
      eventType: "tool_execution",
      content: `Tool call: ${toolName}`,
      metadata: {
        toolName,
        toolCallId: toolCallId || null,
        success: !event?.error,
        error: typeof event?.error === "string" ? event.error : null,
      },
      agentId: hookCtx?.agentId,
      sessionKey: hookCtx?.sessionKey,
      sessionId: hookCtx?.sessionId,
    });
    markBounded(loggedToolCallKeys, key);
  });

  on("agent_end", async (event: any, hookCtx: any) => {
    if (shouldSkipHook(hookCtx)) {
      return;
    }
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    const lastUser = [...messages].reverse().find((message: any) => message?.role === "user");
    const userText = sanitizeUserPrompt(extractText(lastUser?.content));
    if (userText.includes(MAINTENANCE_INTERNAL_MARKER)) {
      return;
    }
    if (userText) {
      await insertEvent({
        eventType: "user_prompt",
        content: userText,
        metadata: {
          success: Boolean(event?.success),
          durationMs: typeof event?.durationMs === "number" ? event.durationMs : null,
        },
        agentId: hookCtx?.agentId,
        sessionKey: hookCtx?.sessionKey,
        sessionId: hookCtx?.sessionId,
      });
    }

    const toolCalls = messages.flatMap((message: any) =>
      Array.isArray(message?.tool_calls) ? message.tool_calls : [],
    );
    for (const call of toolCalls) {
      const toolCallId = typeof call?.id === "string" ? call.id : "";
      const toolName =
        typeof call?.function?.name === "string"
          ? call.function.name
          : toolCallNames.get(toolCallId) ?? "";
      if (!toolName || isMemoryStoreTool(toolName)) {
        continue;
      }
      const args = stringifyToolArgs(undefined, call);
      if (loggedToolCallKeys.has(toolCallKey(toolCallId, toolName, args))) {
        continue;
      }
      if (args.includes(MAINTENANCE_INTERNAL_MARKER)) {
        continue;
      }
      await insertEvent({
        eventType: "tool_execution",
        content: `Tool call: ${toolName}`,
        metadata: {
          toolName,
          toolCallId: toolCallId || null,
        },
        agentId: hookCtx?.agentId,
        sessionKey: hookCtx?.sessionKey,
        sessionId: hookCtx?.sessionId,
      });
      markBounded(loggedToolCallKeys, toolCallKey(toolCallId, toolName, args));
    }
  });
}
