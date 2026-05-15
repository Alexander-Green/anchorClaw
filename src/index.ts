import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  anchorClawConfigSchema,
  type AnchorClawConfig,
} from "./config.js";
import { resolveUserAndWorkspaceScope } from "./identity.js";
import { resolveMemoryLimits } from "./memory/limits.js";
import { memoryGetFromDb } from "./memory/get.js";
import { memorySearchDb } from "./memory/search.js";
import { memoryStoreDb } from "./memory/store.js";
import { memoryForgetDb } from "./memory/forget.js";
import { memoryRecallDb } from "./memory/recall.js";
import {
  memorySearchSessions,
  resolveSessionsDirForAgent,
} from "./memory/sessions.js";
import { hasSessionsIndexRows, memorySearchSessionsIndexDb } from "./memory/sessions-index.js";
import {
  canAccessSessionPathByVisibility,
  filterSessionHitsByVisibility,
} from "./memory/sessions-visibility.js";
import { runOneTimeWorkspaceImport } from "./importer.js";
import { getIdentityStartupWarning } from "./identity-policy.js";
import {
  createPluginRuntimeContext,
  type PluginRuntimeContext,
} from "./plugin/runtime-context.js";
import { createPromptCacheRuntime } from "./plugin/prompt-cache.js";
import { registerAnchorClawMemoryCapability } from "./plugin/capability.js";
import { registerSessionDeltaLifecycle } from "./plugin/lifecycle.js";
import { createSessionDeltaRuntime } from "./plugin/session-delta.js";
import type {
  MemoryStatusCheckResult,
} from "./plugin/types.js";
import fs from "node:fs/promises";
import path from "node:path";

export default definePluginEntry({
  id: "anchorclaw",
  name: "AnchorClaw",
  description: "Postgres-backed long-term memory plugin",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    const selectedMemorySlot =
      typeof api.runtime?.config?.current === "function"
        ? (api.runtime.config.current() as any)?.plugins?.slots?.memory
        : undefined;
    if (selectedMemorySlot !== "anchorclaw") {
      api.logger.info(
        `anchorclaw: installed but not active (plugins.slots.memory=${JSON.stringify(selectedMemorySlot)})`,
      );
      return;
    }

    let cfg: AnchorClawConfig | undefined;
    let disabledReason: string | undefined;
    try {
      cfg = anchorClawConfigSchema.parse(api.pluginConfig);
    } catch (error) {
      disabledReason = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: disabled until configured (${disabledReason})`);
    }
    if (cfg) {
      const warning = getIdentityStartupWarning(cfg);
      if (warning) {
        api.logger.warn(warning);
      }
    }

    const ctx: PluginRuntimeContext = createPluginRuntimeContext({
      api,
      cfg,
      disabledReason,
    });
    const { refreshPromptCache } = createPromptCacheRuntime({ api, ctx });
    const { ensureSessionsIndexBootstrapped, ensureSessionDeltaListener, cleanupSessionDelta } =
      createSessionDeltaRuntime({ api, ctx });

    api.logger.info(
      ctx.cfg
        ? `anchorclaw: plugin registered (db: ${ctx.cfg.postgres.host}, lazy init)`
        : "anchorclaw: plugin registered (disabled until configured)",
    );

    // Best-effort warm-up so the very first prompt often has durable memory available.
    if (ctx.cfg) {
      refreshPromptCache();
      ensureSessionDeltaListener();
    }

    // Best-effort one-time import of legacy memory files from the workspace into Postgres.
    // This does not remove/disable file-based behavior in OpenClaw core; it only populates DB state.
    if (ctx.cfg) {
      const importCfg = ctx.cfg;
      (async () => {
        try {
          await ctx.ensureReady();
          const workspaceDir =
            typeof (api as any)?.runtime?.workspaceDir === "string" && (api as any).runtime.workspaceDir.trim()
              ? String((api as any).runtime.workspaceDir)
              : process.cwd();
          await runOneTimeWorkspaceImport({
            api,
            cfg: importCfg,
            pool: ctx.getPool(),
            workspaceDir,
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
          });
          refreshPromptCache();
        } catch (error) {
          api.logger.warn(
            `anchorclaw: workspace import failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      })();
    }
    registerSessionDeltaLifecycle({ api, cleanupSessionDelta });
    registerAnchorClawMemoryCapability({
      ctx,
      refreshPromptCache,
      ensureSessionsIndexBootstrapped,
    });

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
            try {
              await fs.stat(agentSessionsDir);
              exists = true;
            } catch {
              exists = false;
            }
            base.sessions = {
              enabled: sessionsEnabled,
              visibility: sessionsVisibility,
              stateDir,
              agentSessionsDir,
              exists,
              readable: exists,
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

    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search memory.\n\nMVP rules:\n- corpus defaults to \"memory\" (durable items in Postgres).\n- corpus=\"sessions\" uses Postgres-backed sessions index (DB-first) and returns paths like sessions/<agentId>/<session>.jsonl.\n- Results contain synthetic paths. Use memory_get to read them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Search query text." },
          corpus: {
            type: "string",
            description: "Memory corpus (memory|sessions|all). Defaults to memory.",
            enum: ["memory", "sessions", "all", "wiki"],
          },
          maxResults: { type: "number", description: "Max results (capped by configured limits)." },
          minScore: { type: "number", description: "Optional minimum score threshold." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        if (ctx.disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
            details: { disabled: true, error: ctx.disabledReason },
          };
        }
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: ctx.cfg?.identity?.externalId,
        });
        const limits = resolveMemoryLimits(ctx.cfg!);
        const record = (params ?? {}) as any;
        const query = typeof record.query === "string" ? String(record.query) : "";
        const corpus = typeof record.corpus === "string" ? String(record.corpus) : "memory";
        const maxResults = typeof record.maxResults === "number" ? (record.maxResults as number) : undefined;
        const minScore = typeof record.minScore === "number" ? (record.minScore as number) : undefined;
        const effectiveMax = typeof maxResults === "number" ? maxResults : limits.maxResults;
        const trimmedCorpus = corpus.trim();
        const sessionsVisibility = ctx.cfg?.sessions?.visibility ?? "current";
        const sessionsEnabled = sessionsVisibility !== "off";
        if (trimmedCorpus === "wiki") {
          return {
            content: [
              {
                type: "text",
                text:
                  "anchorclaw: corpus=wiki is not implemented yet. Use the memory-wiki tools (wiki_search/wiki_get) for now.",
              },
            ],
            details: { disabled: true, error: "corpus=wiki not implemented" },
          };
        }
        let hits: any[] = [];
        try {
          if (trimmedCorpus === "sessions") {
            if (!sessionsEnabled) {
              return {
                content: [{ type: "text", text: "anchorclaw: sessions corpus is disabled by config (sessions.visibility=off)" }],
                details: { disabled: true, error: "sessions corpus disabled", visibility: sessionsVisibility },
              };
            }
            await ensureSessionsIndexBootstrapped();
            const indexedHits = await memorySearchSessionsIndexDb({
              pool: ctx.getPool(),
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              limits,
              query,
              maxResults: effectiveMax,
              ...(sessionsVisibility === "current" ? { currentAgentId: String((api as any)?.runtime?.agentId ?? "main") } : {}),
            });
            if (indexedHits.length > 0) {
              hits = indexedHits;
            } else {
              const hasIndex = await hasSessionsIndexRows({
                pool: ctx.getPool(),
                userId: scope.userId,
                workspaceId: scope.workspaceId,
                ...(sessionsVisibility === "current" ? { currentAgentId: String((api as any)?.runtime?.agentId ?? "main") } : {}),
              });
              hits = hasIndex
                ? []
                : await memorySearchSessions({
                    query,
                    maxResults: effectiveMax,
                    agentId: (api as any)?.runtime?.agentId,
                    limits,
                  });
            }
            hits = await filterSessionHitsByVisibility({ api, hits });
          } else if (trimmedCorpus === "memory") {
            hits = await memorySearchDb({
              pool: ctx.getPool(),
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              limits,
              query,
              ...(typeof maxResults === "number" ? { maxResults } : {}),
            });
          } else if (trimmedCorpus === "all") {
            if (sessionsEnabled) {
              await ensureSessionsIndexBootstrapped();
            }
            const merged = [
              ...(await memorySearchDb({
                pool: ctx.getPool(),
                userId: scope.userId,
                workspaceId: scope.workspaceId,
                limits,
                query,
                maxResults: effectiveMax,
              })),
              ...(sessionsEnabled
                ? await memorySearchSessionsIndexDb({
                    pool: ctx.getPool(),
                    userId: scope.userId,
                    workspaceId: scope.workspaceId,
                    limits,
                    query,
                    maxResults: effectiveMax,
                    ...(sessionsVisibility === "current" ? { currentAgentId: String((api as any)?.runtime?.agentId ?? "main") } : {}),
                  })
                : []),
            ];
            if (sessionsEnabled) {
              const hasSessionsHits = merged.some((item: any) => item?.corpus === "sessions");
              if (!hasSessionsHits) {
                const hasIndex = await hasSessionsIndexRows({
                  pool: ctx.getPool(),
                  userId: scope.userId,
                  workspaceId: scope.workspaceId,
                  ...(sessionsVisibility === "current" ? { currentAgentId: String((api as any)?.runtime?.agentId ?? "main") } : {}),
                });
                if (!hasIndex) {
                merged.push(
                  ...(await memorySearchSessions({
                    query,
                    maxResults: effectiveMax,
                    agentId: (api as any)?.runtime?.agentId,
                    limits,
                  })),
                );
                }
              }
            }
            const mergedForOutput = sessionsEnabled
              ? await filterSessionHitsByVisibility({ api, hits: merged })
              : merged;
            mergedForOutput.sort((left: any, right: any) => {
              const ls = typeof left?.score === "number" ? left.score : 0;
              const rs = typeof right?.score === "number" ? right.score : 0;
              if (rs !== ls) {
                return rs - ls;
              }
              // Prefer durable memory over sessions when equal.
              const lc = left?.corpus === "sessions" ? "sessions" : "memory";
              const rc = right?.corpus === "sessions" ? "sessions" : "memory";
              if (lc !== rc) {
                return lc === "memory" ? -1 : 1;
              }
              const lp = typeof left?.path === "string" ? left.path : "";
              const rp = typeof right?.path === "string" ? right.path : "";
              return lp.localeCompare(rp);
            });
            hits = mergedForOutput.slice(0, effectiveMax);
          }
          ctx.markSdkSuccess();
        } catch (error) {
          ctx.markSdkError(`memory_search:${trimmedCorpus || "unknown"}`, error);
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `anchorclaw: memory_search degraded (sdk/runtime error: ${message})` }],
            details: {
              disabled: true,
              error: message,
              degraded: true,
              degradedReason: "sdk_error",
              sdk: { ...ctx.sdkHealth },
            },
          };
        }

        if (trimmedCorpus !== "memory" && trimmedCorpus !== "sessions" && trimmedCorpus !== "all") {
          return {
            content: [{ type: "text", text: `anchorclaw: unsupported corpus (${trimmedCorpus || "empty"})` }],
            details: { disabled: true, error: "unsupported corpus", corpus: trimmedCorpus },
          };
        }

        if (typeof minScore === "number" && Number.isFinite(minScore)) {
          hits = hits.filter((hit: any) => typeof hit?.score === "number" && hit.score >= minScore);
        }
        return {
          content: [{ type: "text", text: hits.length ? `Found ${hits.length} result(s).` : "No results." }],
          details: {
            results: hits,
            count: hits.length,
            ...(ctx.sdkHealth.degraded
              ? { degraded: true, degradedReason: "sdk_error", sdk: { ...ctx.sdkHealth } }
              : {}),
          },
        };
      },
    });

    api.registerTool({
      name: "memory_get",
      label: "Memory Get",
      description:
        "Read durable long-term memory content by path.\n\nMVP rules:\n- Pass lookup as a synthetic DB path returned by memory_search/memory_store (e.g. db-memory/items/<uuid>.md), or sessions/<agentId>/<file>, or MEMORY.md (virtual snapshot).\n- OpenClaw-compatible aliases: you may pass { path, from, lines } instead of { lookup, fromLine, lineCount }.\n- Content is returned as a bounded excerpt (use fromLine/lineCount to paginate).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          lookup: { type: "string", description: "AnchorClaw lookup path (preferred): db-memory/... or sessions/... or MEMORY.md." },
          fromLine: { type: "number", description: "AnchorClaw alias for 'from' (1-based line number)." },
          lineCount: { type: "number", description: "AnchorClaw alias for 'lines' (number of lines)." },

          // OpenClaw-compatible aliases.
          path: { type: "string", description: "OpenClaw-compatible alias for lookup." },
          from: { type: "number", description: "OpenClaw-compatible alias for fromLine." },
          lines: { type: "number", description: "OpenClaw-compatible alias for lineCount." },
          corpus: { type: "string", description: "Optional corpus hint (ignored by AnchorClaw tools; use lookup/path).", enum: ["memory", "sessions", "wiki", "all"] },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        if (ctx.disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
            details: { disabled: true, error: ctx.disabledReason },
          };
        }
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
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
        const sessionsVisibility = ctx.cfg?.sessions?.visibility ?? "current";
        if (sessionsVisibility === "off" && lookup.trim().startsWith("sessions/")) {
          return {
            content: [{ type: "text", text: "anchorclaw: sessions corpus is disabled by config (sessions.visibility=off)" }],
            details: { disabled: true, error: "sessions corpus disabled", visibility: sessionsVisibility },
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
            workspaceDir:
              typeof (api as any)?.runtime?.workspaceDir === "string" && (api as any).runtime.workspaceDir.trim()
                ? String((api as any).runtime.workspaceDir)
                : process.cwd(),
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

    api.registerTool({
      name: "memory_store",
      label: "Memory Store",
      description:
        "Store durable long-term memory into Postgres.\n\nMVP rules:\n- Always provide { content }.\n- If you are storing an updateable fact/preference/setting, provide { canonicalKey } so future calls overwrite the same logical item (instead of creating duplicates).\n- Optionally provide { type: \"fact\"|\"note\"|... } (default: \"note\").",
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
          // Alias for compatibility with other ecosystems (e.g. older tools/docs).
          canonical_key: {
            type: "string",
            description: "Alias for canonicalKey.",
          },
          type: {
            type: "string",
            description: "Optional memory item type (default: note).",
            // MVP: keep this aligned with the OpenClaw MEMORY.md role (durable facts/preferences + notes).
            // Future: add explicit policy + injection budgets before enabling other types.
            enum: ["fact", "note"],
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
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
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

        // Best-effort refresh after writes so prompt cache stays warm.
        refreshPromptCache();

        return {
          content: [{ type: "text", text: `Stored: ${stored.path}` }],
          details: stored,
        };
      },
    });

    api.registerTool({
      name: "memory_recall",
      label: "Memory Recall",
      description: "Recall relevant long-term memory from Postgres (shortcut).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description:
              "Optional query. If provided, AnchorClaw behaves like memory_search. If empty, returns top important recent durable items.",
          },
          maxResults: { type: "number", description: "Max results (capped by configured limits)." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        if (ctx.disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
            details: { disabled: true, error: ctx.disabledReason },
          };
        }
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: ctx.cfg?.identity?.externalId,
        });
        const limits = resolveMemoryLimits(ctx.cfg!);
        const recalled = await memoryRecallDb({
          pool: ctx.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          limits,
          input: params,
        });

        if (!recalled.ok) {
          return {
            content: [{ type: "text", text: `anchorclaw: memory_recall failed (${recalled.error})` }],
            details: recalled,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: recalled.count ? `Recalled ${recalled.count} item(s).` : "No recalled items.",
            },
          ],
          details: recalled,
        };
      },
    });

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
          // OpenClaw-style alias (matches memory_get).
          path: {
            type: "string",
            description: "Alias for lookup (OpenClaw-style).",
          },
          id: { type: "string", description: "Memory item UUID (alternative to lookup)." },
        },
      },
      async execute(_toolCallId: string, params: unknown) {
        if (ctx.disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${ctx.disabledReason})` }],
            details: { disabled: true, error: ctx.disabledReason },
          };
        }
        await ctx.ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: ctx.getPool(),
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

        // Best-effort refresh after writes so prompt cache stays warm.
        refreshPromptCache();

        return {
          content: [
            {
              type: "text",
              text: forgot.deleted > 0 ? `Forgot ${forgot.deleted} item(s).` : "Nothing to forget.",
            },
          ],
          details: forgot,
        };
      },
    });
  },
});
