import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveSessionsSearchState } from "../../config.js";
import { memoryGetFromDb } from "../../memory/get.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { canAccessSessionPathByVisibility } from "../../memory/sessions-visibility.js";
import { resolveSessionSearchMode } from "../session-search-mode.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";

export function registerMemoryGetTool({ ctx, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  const registeredSessionSearchMode = resolveSessionSearchMode(api);
  const sessionsDescription =
    registeredSessionSearchMode === "legacy-anchorclaw"
      ? "Legacy OpenClaw sessions/<agentId>/<file> paths are also accepted when sessions search is enabled."
      : "Use OpenClaw sessions_search and sessions_history for conversation transcripts.";
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_get",
    label: "Memory Get",
    description: [
      "Read memory content by path.",
      "",
      "Rules:",
      "- Pass lookup as a synthetic DB path returned by memory_search/memory_store (e.g. db-memory/items/<uuid>.md), MEMORY.md (virtual snapshot), or memory/YYYY-MM-DD.md (DB-backed daily memory).",
      `- ${sessionsDescription}`,
      "- OpenClaw-compatible aliases: you may pass { path, from, lines } instead of { lookup, fromLine, lineCount }.",
      "- Content is returned as a bounded excerpt (use fromLine/lineCount to paginate).",
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        lookup: { type: "string", description: "AnchorClaw lookup path (preferred): db-memory/... or sessions/... or MEMORY.md or memory/YYYY-MM-DD.md." },
        fromLine: { type: "number", description: "AnchorClaw alias for 'from' (1-based line number)." },
        lineCount: { type: "number", description: "AnchorClaw alias for 'lines' (number of lines)." },
        path: { type: "string", description: "OpenClaw-compatible alias for lookup." },
        from: { type: "number", description: "OpenClaw-compatible alias for fromLine." },
        lines: { type: "number", description: "OpenClaw-compatible alias for lineCount." },
        corpus: { type: "string", description: "Optional corpus hint (ignored by AnchorClaw tools; use lookup/path).", enum: ["memory", "sessions", "wiki", "all"] },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      const record = (params ?? {}) as any;
      const lookup =
        typeof record.lookup === "string" && record.lookup.trim()
          ? String(record.lookup)
          : typeof record.path === "string" && record.path.trim()
            ? String(record.path)
            : "";
      const fromLine = typeof record.fromLine === "number" ? record.fromLine : record.from;
      const lineCount = typeof record.lineCount === "number" ? record.lineCount : record.lines;
      if (!lookup.trim()) {
        return {
          content: [{ type: "text", text: "anchorclaw: memory_get requires lookup (or path)" }],
          details: { disabled: true, error: "lookup required" },
        };
      }
      if (
        registeredSessionSearchMode === "native-openclaw" &&
        lookup.trim().startsWith("sessions/")
      ) {
        return {
          content: [
            {
              type: "text",
              text: "anchorclaw: session transcripts are managed by OpenClaw; use sessions_search and sessions_history",
            },
          ],
          details: {
            disabled: true,
            error: "sessions source managed by OpenClaw",
            replacementTools: ["sessions_search", "sessions_history"],
          },
        };
      }
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
      const limits = resolveMemoryLimits(ctx.cfg!);
      const sessionsSearch = resolveSessionsSearchState(ctx.cfg);
      const sessionsVisibility = sessionsSearch.visibility;
      if (!sessionsSearch.effective && lookup.trim().startsWith("sessions/")) {
        return {
          content: [{ type: "text", text: "anchorclaw: sessions source is unavailable until sessions.search.enabled=true" }],
          details: {
            disabled: true,
            error: "sessions source unavailable",
            sessions: {
              configured: sessionsSearch.configured,
              effective: sessionsSearch.effective,
              visibility: sessionsSearch.visibility,
              ...(sessionsSearch.reason ? { reason: sessionsSearch.reason } : {}),
            },
          },
        };
      }
      if (lookup.trim().startsWith("sessions/")) {
        const verdict = await canAccessSessionPathByVisibility({
          api,
          runtimeConfig: toolCtx.runtimeConfig,
          getRuntimeConfig: toolCtx.getRuntimeConfig,
          sessionKey: toolCtx.sessionKey,
          sandboxed: (toolCtx as any).sandboxed,
          path: lookup.trim(),
        });
        if (!verdict.allowed) {
          return {
            content: [
              {
                type: "text",
                text: `anchorclaw: memory_get failed (${verdict.reason ?? "sessions lookup visibility denied"})`,
              },
            ],
            details: {
              disabled: true,
              error: verdict.reason ?? "sessions lookup visibility denied",
            },
          };
        }
      }
      let got: any;
      try {
        got = await memoryGetFromDb({
          pool: ctx.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: workspaceTarget.agentId,
          sessionsVisibility,
          limits,
          lookup,
          ...(typeof fromLine === "number" ? { fromLine } : {}),
          ...(typeof lineCount === "number" ? { lineCount } : {}),
        });
        ctx.markSdkSuccess();
      } catch (error) {
        ctx.markSdkError("memory_get", error);
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `anchorclaw: memory_get degraded (sdk/runtime error: ${message})` }],
          details: {
            disabled: true,
            error: message,
            degraded: true,
            degradedReason: "sdk_error",
            sdk: { ...ctx.sdkHealth },
          },
        };
      }
      if (!got.ok) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_get failed (${got.error})` }],
          details: {
            ...got,
            ...(ctx.sdkHealth.degraded
              ? { degraded: true, degradedReason: "sdk_error", sdk: { ...ctx.sdkHealth } }
              : {}),
          },
        };
      }
      return {
        content: [{ type: "text", text: got.content }],
        details: {
          ...got,
          ...(ctx.sdkHealth.degraded
            ? { degraded: true, degradedReason: "sdk_error", sdk: { ...ctx.sdkHealth } }
            : {}),
        },
      };
    },
  }), { name: "memory_get" });
}
