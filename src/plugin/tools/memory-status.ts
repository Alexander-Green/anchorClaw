import { resolveSessionsDirForAgent } from "../../memory/sessions.js";
import type { MemoryStatusCheckResult } from "../types.js";
import type { ToolRegistrationParams } from "./common.js";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function registerMemoryStatusTool({ ctx }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_status",
    label: "Memory Status",
    description:
      "Return runtime health state for AnchorClaw memory operations.\n\nMVP rules:\n- Use this for operator diagnostics.\n- It reports SDK degraded state without exposing secrets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        check: {
          type: "boolean",
          description:
            "When true, performs active health checks (database connectivity/schema + sessions dir accessibility).",
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
      const record = (params ?? {}) as { check?: unknown };
      const activeCheck = record.check === true;
      const base: MemoryStatusCheckResult = {
        ok: true,
        mode: activeCheck ? "active" : "cached",
        sdk: { ...ctx.sdkHealth },
      };
      if (activeCheck) {
        const startedAt = Date.now();
        let dbError: string | undefined;
        try {
          await ctx.ensureReady();
          await ctx.getPool().query("SELECT 1");
          const schemaRows = await ctx.getPool().query<{
            memory_items: string | null;
            session_index_files: string | null;
            session_index_chunks: string | null;
            schema_migrations: string | null;
          }>(
            "SELECT to_regclass('memory_items') AS memory_items, to_regclass('session_index_files') AS session_index_files, to_regclass('session_index_chunks') AS session_index_chunks, to_regclass('schema_migrations') AS schema_migrations",
          );
          const schema = schemaRows.rows[0];
          const schemaOk = Boolean(
            schema?.memory_items &&
              schema?.session_index_files &&
              schema?.session_index_chunks &&
              schema?.schema_migrations,
          );
          const migrationRows = await ctx.getPool().query<{ id: string }>(
            "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
          );
          base.database = {
            ok: schemaOk,
            latencyMs: Math.max(0, Date.now() - startedAt),
            schemaOk,
            migrationVersion: migrationRows.rows[0]?.id ?? null,
          };
          if (!schemaOk) {
            base.ok = false;
          }
        } catch (error) {
          dbError = error instanceof Error ? error.message : String(error);
          base.ok = false;
          base.database = {
            ok: false,
            error: dbError,
          };
        }

        const sessionsVisibility = ctx.cfg?.sessions?.visibility ?? "current";
        const sessionsEnabled = sessionsVisibility !== "off";
        try {
          const agentId = String((api as any)?.runtime?.agentId ?? "main");
          const agentSessionsDir = await resolveSessionsDirForAgent(agentId);
          const stateDir = path.dirname(path.dirname(path.dirname(agentSessionsDir)));
          let exists = false;
          let readable = false;
          try {
            await fs.stat(agentSessionsDir);
            exists = true;
          } catch {
            exists = false;
          }
          if (exists) {
            try {
              await fs.access(agentSessionsDir, fsConstants.R_OK);
              readable = true;
            } catch {
              readable = false;
            }
          }
          base.sessions = {
            enabled: sessionsEnabled,
            visibility: sessionsVisibility,
            stateDir,
            agentSessionsDir,
            exists,
            readable,
          };
        } catch (error) {
          base.ok = false;
          base.sessions = {
            enabled: sessionsEnabled,
            visibility: sessionsVisibility,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        const pending = Array.from(ctx.sessionDelta.stateByPath.values()).reduce(
          (acc, item) => {
            acc.pendingBytes += item.pendingBytes;
            acc.pendingMessages += item.pendingMessages;
            return acc;
          },
          { pendingBytes: 0, pendingMessages: 0 },
        );
        base.index = {
          trackedFiles: ctx.sessionDelta.stateByPath.size,
          pendingBytes: pending.pendingBytes,
          pendingMessages: pending.pendingMessages,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: ctx.sdkHealth.degraded
              ? `AnchorClaw memory is degraded (${ctx.sdkHealth.reason ?? "unknown error"}).`
              : activeCheck && !base.ok
                ? "AnchorClaw memory active check failed."
                : "AnchorClaw memory is healthy.",
          },
        ],
        details: base,
      };
    },
  });
}
