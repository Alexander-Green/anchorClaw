import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveSessionsSearchState } from "../../config.js";
import { memoryGetFromDb } from "../../memory/get.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { canAccessSessionPathByVisibility } from "../../memory/sessions-visibility.js";
import { resolveConfiguredWorkspaceDir, WORKSPACE_DIR_UNAVAILABLE } from "../../workspace.js";
import { ensureToolRuntimeReady, type ToolRegistrationParams } from "./common.js";

export function registerMemoryGetTool({ ctx, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description:
      "Read memory content by path.\n\nMVP rules:\n- Pass lookup as a synthetic DB path returned by memory_search/memory_store (e.g. db-memory/items/<uuid>.md), or sessions/<agentId>/<file>, or MEMORY.md (virtual snapshot), or memory/YYYY-MM-DD.md (DB-backed daily memory).\n- OpenClaw-compatible aliases: you may pass { path, from, lines } instead of { lookup, fromLine, lineCount }.\n- Content is returned as a bounded excerpt (use fromLine/lineCount to paginate).",
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
      const unavailable = await ensureToolRuntimeReady(ctx, ensureStartupBootstrap);
      if (unavailable) return unavailable;
      await ctx.ensureReady();
      const workspaceDir = resolveConfiguredWorkspaceDir(ctx.cfg);
      if (!workspaceDir) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_get unavailable (${WORKSPACE_DIR_UNAVAILABLE})` }],
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
      const limits = resolveMemoryLimits(ctx.cfg!);
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
          agentId: (api as any)?.runtime?.agentId,
          sessionsVisibility,
          workspaceDir,
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
  });
}
