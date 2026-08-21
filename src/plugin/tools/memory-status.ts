import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveSessionsDirForAgent } from "../../memory/sessions.js";
import {
  resolveSessionsSearchState,
} from "../../config.js";
import { resolveSessionSearchMode } from "../session-search-mode.js";
import { resolveConversationAccessState } from "../conversation-access.js";
import { scanLegacyWorkspace } from "../../importer.js";
import {
  inspectSemanticSchema,
  probeSemanticProvider,
  resolveSemanticRuntimeProfile,
} from "../../semantic/runtime.js";
import type { MemoryStatusCheckResult } from "../types.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function isPromptInjectionAllowed(api: any, toolCtx: OpenClawPluginToolContext): boolean {
  const toolConfig =
    toolCtx.runtimeConfig ??
    (typeof toolCtx.getRuntimeConfig === "function" ? toolCtx.getRuntimeConfig() : undefined);
  const toolHooks = toolConfig?.plugins?.entries?.anchorclaw?.hooks;
  if (toolHooks) return toolHooks.allowPromptInjection !== false;

  const currentConfig =
    typeof api?.runtime?.config?.current === "function" ? api.runtime.config.current() : undefined;
  const hooks = currentConfig?.plugins?.entries?.anchorclaw?.hooks;
  return hooks?.allowPromptInjection !== false;
}

function describeSemanticSchemaGap(params: {
  vectorExtensionInstalled: boolean;
  embeddingsTableReady: boolean;
  indexingRequestsTableReady: boolean;
  migrationsTableReady: boolean;
}): string {
  const missing: string[] = [];
  if (!params.vectorExtensionInstalled) {
    missing.push("pgvector extension");
  }
  if (!params.embeddingsTableReady) {
    missing.push("memory_item_embeddings");
  }
  if (!params.indexingRequestsTableReady) {
    missing.push("semantic_indexing_requests");
  }
  if (!params.migrationsTableReady) {
    missing.push("semantic_schema_migrations");
  }
  return `semantic schema not ready (${missing.join(", ")} missing)`;
}

export function registerMemoryStatusTool({ ctx, ensureStartupBootstrap }: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_status",
    label: "Memory Status",
    description:
      "Return runtime health state for AnchorClaw memory operations.\n\nRules:\n- Diagnostics only: use for operator health/debug checks.\n- Do not use this tool for fact lookup, retrieval ranking, or answer selection.\n- It reports SDK degraded state without exposing secrets.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        check: {
          type: "boolean",
          description:
            "When true, performs active health checks for database/schema, sessions accessibility, and the configured semantic provider.",
        },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      const record = (params ?? {}) as { check?: unknown };
      const activeCheck = record.check === true;
      const unavailable = await ensureToolRuntimeReady(ctx, ensureStartupBootstrap);
      if (unavailable && (!activeCheck || Boolean(ctx.disabledReason))) {
        return unavailable;
      }
      const promptInjectionAllowed = isPromptInjectionAllowed(api, toolCtx);
      // The host can block before_prompt_build independently of allowPromptInjection,
      // so "allowed" alone would report memory injection as working when it is not.
      const conversationAccessBlocked = resolveConversationAccessState(api).blocked;
      const resolveSemanticRuntimeConfig = () =>
        toolCtx.runtimeConfig ??
        (typeof toolCtx.getRuntimeConfig === "function" ? toolCtx.getRuntimeConfig() : undefined) ??
        (typeof api?.runtime?.config?.current === "function" ? api.runtime.config.current() : undefined);
      const resolveSemanticAgentId = () =>
        toolCtx.agentId ?? ((api as any)?.runtime?.agentId as string | undefined);
      const logSemanticError = (params: {
        error: string;
        agentId?: string;
        provider?: string;
        model?: string;
      }) => {
        const parts = [
          `anchorclaw: semantic status check warning (${params.error})`,
          params.agentId ? `agent=${params.agentId}` : undefined,
          params.provider ? `provider=${params.provider}` : undefined,
          params.model ? `model=${params.model}` : undefined,
        ].filter(Boolean);
        api.logger.warn(parts.join(" "));
      };
      const buildSemanticStatus = (agentId?: string, runtimeConfig?: unknown) => {
        return resolveSemanticRuntimeProfile({
          cfg: ctx.cfg,
          runtimeConfig: runtimeConfig ?? resolveSemanticRuntimeConfig(),
          agentId: agentId ?? resolveSemanticAgentId(),
        }).profile;
      };
      const base: MemoryStatusCheckResult = {
        ok: ctx.durableState?.overall === "ready",
        backend: "anchorclaw",
        overall: ctx.durableState?.overall ?? "blocked",
        databaseState: ctx.durableState?.database ?? "failed",
        migrationsState: ctx.durableState?.migrations ?? "failed",
        importState: ctx.durableState?.import ?? "failed_permanent",
        cleanupState: ctx.durableState?.cleanup ?? "failed",
        reason: ctx.durableState?.reason ?? ctx.disabledReason ?? null,
        mode: activeCheck ? "active" : "cached",
        sdk: { ...ctx.sdkHealth },
        daily: {
          source: "db",
          injectionMode: "first_turn",
          promptInjectionAllowed,
          startupPromptEnabled: true,
          startupPromptEffective: promptInjectionAllowed && !conversationAccessBlocked,
          readCompatibilityPath: "db-only",
          importMode: "canonical_table",
        },
        semantic: buildSemanticStatus(),
      };
      if (activeCheck) {
        let semanticWarningLogged = false;
        let workspaceTarget: {
          workspaceDir: string;
          agentId: string;
          sessionKey?: string;
          sessionId?: string;
        } | null = null;
        const getWorkspaceTarget = () => {
          if (workspaceTarget) return workspaceTarget;
          const resolved = resolveRuntimeToolWorkspace({
            ctx,
            runtimeConfig: toolCtx.runtimeConfig,
            getRuntimeConfig: toolCtx.getRuntimeConfig,
            workspaceDir: toolCtx.workspaceDir,
            agentId: toolCtx.agentId,
            sessionKey: toolCtx.sessionKey,
            sessionId: toolCtx.sessionId,
          });
          if ("content" in resolved) {
            throw new Error(String(resolved.details.error ?? "runtime_workspace_unavailable"));
          }
          workspaceTarget = resolved;
          const targetSemantic = buildSemanticStatus(workspaceTarget.agentId, toolCtx.runtimeConfig);
          base.semantic = base.semantic
            ? {
                ...base.semantic,
                ...targetSemantic,
              }
            : targetSemantic;
          if (base.semantic?.error && !semanticWarningLogged) {
            logSemanticError({
              error: base.semantic.error,
              agentId: workspaceTarget.agentId,
              provider: base.semantic.provider,
              model: base.semantic.model,
            });
            semanticWarningLogged = true;
          }
          return workspaceTarget;
        };
        if (base.semantic?.error && !semanticWarningLogged) {
          logSemanticError({
            error: base.semantic.error,
            agentId: resolveSemanticAgentId(),
            provider: base.semantic.provider,
            model: base.semantic.model,
          });
          semanticWarningLogged = true;
        }
        const startedAt = Date.now();
        let dbError: string | undefined;
        try {
          await ctx.ensureReady();
          const pool = ctx.getPool();
          await pool.query("SELECT 1");
          const schemaRows = await pool.query<{
            memory_items: string | null;
            memory_daily_entries: string | null;
            memory_daily_blocks: string | null;
            memory_daily_block_extraction_windows: string | null;
            session_index_files: string | null;
            session_index_chunks: string | null;
            schema_migrations: string | null;
          }>(
            "SELECT to_regclass('memory_items') AS memory_items, to_regclass('memory_daily_entries') AS memory_daily_entries, to_regclass('memory_daily_blocks') AS memory_daily_blocks, to_regclass('memory_daily_block_extraction_windows') AS memory_daily_block_extraction_windows, to_regclass('session_index_files') AS session_index_files, to_regclass('session_index_chunks') AS session_index_chunks, to_regclass('schema_migrations') AS schema_migrations",
          );
          const schema = schemaRows.rows[0];
          const dailySchemaOk = Boolean(
            schema?.memory_daily_entries &&
              schema?.memory_daily_blocks &&
              schema?.memory_daily_block_extraction_windows,
          );
          const schemaOk = Boolean(
            schema?.memory_items &&
              dailySchemaOk &&
              schema?.session_index_files &&
              schema?.session_index_chunks &&
              schema?.schema_migrations,
          );
          const migrationRows = await pool.query<{ id: string }>(
            "SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1",
          );
          base.database = {
            ok: schemaOk,
            latencyMs: Math.max(0, Date.now() - startedAt),
            schemaOk,
            dailySchemaOk,
            migrationVersion: migrationRows.rows[0]?.id ?? null,
            ...(!schemaOk && base.reason ? { error: base.reason } : {}),
          };
          if (!schemaOk) {
            base.ok = false;
            base.overall = "blocked";
            base.migrationsState = "failed";
            base.reason ??= "schema_incomplete";
          }
          if (base.semantic?.enabled) {
            const semanticSchema = await inspectSemanticSchema({ pool });
            const currentSemantic =
              base.semantic ?? buildSemanticStatus(resolveSemanticAgentId(), toolCtx.runtimeConfig);
            base.semantic = {
              ...currentSemantic,
              schemaReady: semanticSchema.schemaReady,
              schemaVersion: semanticSchema.schemaVersion,
              vectorExtensionInstalled: semanticSchema.vectorExtensionInstalled,
              indexingRequestsTableReady: semanticSchema.indexingRequestsTableReady,
            };
            if (!semanticSchema.schemaReady && !base.semantic.error) {
              base.semantic.error = describeSemanticSchemaGap(semanticSchema);
            }
            if (base.semantic.error && !semanticWarningLogged) {
              logSemanticError({
                error: base.semantic.error,
                agentId: resolveSemanticAgentId(),
                provider: base.semantic.provider,
                model: base.semantic.model,
              });
              semanticWarningLogged = true;
            }
          }
        } catch (error) {
          dbError = error instanceof Error ? error.message : String(error);
          const migrationReason = dbError.startsWith("migrations_failed:") ? dbError : `migrations_failed: ${dbError}`;
          base.ok = false;
          base.overall = "blocked";
          base.migrationsState = "failed";
          base.reason = migrationReason;
          base.database = {
            ok: false,
            error: migrationReason,
          };
        }

        const sessionsSearch = resolveSessionsSearchState(ctx.cfg);
        const sessionSearchMode = resolveSessionSearchMode(api);
        const sessionsVisibility = sessionsSearch.visibility;
        const sessionsEnabled =
          sessionsSearch.effective && sessionSearchMode === "legacy-anchorclaw";
        if (sessionSearchMode === "native-openclaw") {
          base.sessions = {
            enabled: false,
            searchEnabled: sessionsSearch.configured,
            effectiveEnabled: false,
            mode: sessionSearchMode,
            visibility: sessionsVisibility,
            reasonCode: "native_openclaw",
          };
        } else {
        try {
          const target = getWorkspaceTarget();
          const agentId = target.agentId;
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
            searchEnabled: sessionsSearch.configured,
            effectiveEnabled: sessionsEnabled,
            mode: sessionSearchMode,
            visibility: sessionsVisibility,
            ...(sessionsSearch.reason ? { reasonCode: sessionsSearch.reason } : {}),
            stateDir,
            agentSessionsDir,
            exists,
            readable,
          };
        } catch (error) {
          base.ok = false;
          base.sessions = {
            enabled: sessionsEnabled,
            searchEnabled: sessionsSearch.configured,
            effectiveEnabled: sessionsEnabled,
            mode: sessionSearchMode,
            visibility: sessionsVisibility,
            ...(sessionsSearch.reason ? { reasonCode: sessionsSearch.reason } : {}),
            error: error instanceof Error ? error.message : String(error),
          };
        }
        }

        try {
          const target = getWorkspaceTarget();
          const semanticProbe = await probeSemanticProvider({
            cfg: ctx.cfg,
            runtimeConfig: resolveSemanticRuntimeConfig(),
            agentId: target.agentId,
          });
          if (semanticProbe) {
            const currentSemantic = base.semantic ?? buildSemanticStatus(target.agentId, toolCtx.runtimeConfig);
            base.semantic = {
              ...currentSemantic,
              checked: semanticProbe.checked,
              checkedAtMs: semanticProbe.checkedAtMs,
              providerKind: semanticProbe.providerKind,
              providerReachable: semanticProbe.providerReachable,
              ...(typeof semanticProbe.dimensions === "number"
                ? { dimensions: semanticProbe.dimensions }
                : {}),
              ...(semanticProbe.error ? { error: semanticProbe.error } : {}),
            };
            if (semanticProbe.error && !semanticWarningLogged) {
              logSemanticError({
                error: semanticProbe.error,
                agentId: target.agentId,
                provider: base.semantic?.provider,
                model: base.semantic?.model,
              });
              semanticWarningLogged = true;
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const workspaceAgentId = (workspaceTarget as { agentId?: string } | null)?.agentId;
          const currentSemantic =
            base.semantic ??
            buildSemanticStatus(workspaceAgentId ?? resolveSemanticAgentId(), toolCtx.runtimeConfig);
          base.semantic = {
            ...currentSemantic,
            checked: true,
            checkedAtMs: Date.now(),
            providerReachable: false,
            error: message,
          };
          if (!semanticWarningLogged) {
            const warnedAgentId = workspaceAgentId ?? resolveSemanticAgentId();
            logSemanticError({
              error: message,
              agentId: warnedAgentId,
              provider: base.semantic?.provider,
              model: base.semantic?.model,
            });
            semanticWarningLogged = true;
          }
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
        try {
          const workspaceTarget = getWorkspaceTarget();
          const legacyScan = await scanLegacyWorkspace({
            api,
            cfg: ctx.cfg!,
            pool: ctx.getPool(),
            sourceDir: workspaceTarget.workspaceDir,
            targetWorkspaceDir: workspaceTarget.workspaceDir,
            agentId: workspaceTarget.agentId,
            sessionKey: workspaceTarget.sessionKey,
          });
          base.legacyImport = {
            active: legacyScan.hasActiveLegacy,
            memoryMdState: legacyScan.memoryMd.state,
            pendingCount: legacyScan.pendingCount,
            unsupportedCount: legacyScan.unsupportedCount,
            unreadableCount: legacyScan.unreadableCount,
            dailyFileCount: legacyScan.dailyFiles.length,
          };
        } catch (error) {
          base.legacyImport = {
            active: false,
            memoryMdState: "absent",
            pendingCount: 0,
            unsupportedCount: 0,
            unreadableCount: 0,
            dailyFileCount: 0,
          };
          api.logger.warn(
            `anchorclaw: legacy import status scan failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      return {
        content: [
          {
            type: "text",
            text:
              base.overall === "blocked"
                ? `AnchorClaw memory is blocked (${base.reason ?? "durable memory unavailable"}).`
                : base.overall === "degraded"
                  ? `AnchorClaw memory is degraded (${base.reason ?? "legacy MEMORY.md cleanup failed"}).`
                  : ctx.sdkHealth.degraded
                    ? `AnchorClaw memory is degraded (${ctx.sdkHealth.reason ?? "unknown error"}).`
                    : activeCheck && !base.ok
                      ? "AnchorClaw memory active check failed."
                      : "AnchorClaw memory is healthy.",
          },
        ],
        details: base,
      };
    },
  }), { name: "memory_status" });
}
