import { definePluginEntry, type OpenClawPluginApi, registerMemoryCapability } from "./api.js";
import { anchorClawConfigSchema, type AnchorClawConfig } from "./config.js";
import { resolveUserAndWorkspaceScope } from "./identity.js";
import { applyMigrations } from "./migrations.js";
import { loadBundledMigrationsFromDisk } from "./migrations-fs.js";
import { createPostgresPool, type PostgresPool } from "./postgres.js";
import { resolveMemoryLimits } from "./memory/limits.js";
import { memoryGetFromDb } from "./memory/get.js";
import { memorySearchDb } from "./memory/search.js";
import { memoryStoreDb } from "./memory/store.js";
import { memoryForgetDb } from "./memory/forget.js";
import { memoryRecallDb } from "./memory/recall.js";
import { buildPromptMemorySection, queryPromptMemoryItems } from "./memory/prompt.js";
import { memorySearchSessions } from "./memory/sessions.js";
import { memorySearchSessionsIndexDb } from "./memory/sessions-index.js";
import { syncSessionsIndexDb } from "./memory/sessions-index-sync.js";
import {
  createAnchorClawMemorySearchManager,
  type AnchorClawMemorySearchManagerOptions,
} from "./memory/manager.js";
import { runOneTimeWorkspaceImport } from "./importer.js";
import { getIdentityStartupWarning } from "./identity-policy.js";

function resolveActor(api: OpenClawPluginApi): string {
  const agentId = (api as any)?.runtime?.agentId;
  if (typeof agentId === "string" && agentId.trim()) {
    return `openclaw:agent:${agentId.trim()}`;
  }
  const sessionKey = (api as any)?.runtime?.sessionKey;
  if (typeof sessionKey === "string" && sessionKey.trim()) {
    return `openclaw:session:${sessionKey.trim()}`;
  }
  return "openclaw";
}

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

    let pool: PostgresPool | undefined;
    let migrationsApplied: Promise<void> | undefined;
    const getPool = () => {
      if (!cfg) {
        throw new Error(`anchorclaw: disabled until configured (${disabledReason ?? "invalid config"})`);
      }
      pool ??= createPostgresPool({ cfg });
      migrationsApplied ??= (async () => {
        if (cfg?.postgres?.schema) {
          const schema = cfg.postgres.schema.trim();
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
            throw new Error("postgres.schema must be a simple identifier (letters/numbers/underscore)");
          }
          await pool!.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
        }
        const migrations = await loadBundledMigrationsFromDisk();
        const result = await applyMigrations({ pool: pool!, migrations });
        if (result.applied.length > 0) {
          api.logger.info(`anchorclaw: applied migrations: ${result.applied.join(", ")}`);
        }
      })();
      return pool;
    };

    const ensureReady = async () => {
      getPool();
      await migrationsApplied;
    };

    // PromptBuilder is synchronous in OpenClaw, so we keep a best-effort cached durable memory block.
    // It is refreshed lazily (on demand) and opportunistically after successful writes.
    let promptCacheLines: string[] | null = null;
    let promptCacheError: string | null = null;
    let promptCacheRefreshPromise: Promise<void> | null = null;
    let sessionsIndexBootstrapPromise: Promise<void> | null = null;
    const refreshPromptCache = () => {
      if (!cfg) {
        promptCacheLines = null;
        promptCacheError = disabledReason ?? "invalid config";
        return;
      }
      if (promptCacheRefreshPromise) {
        return;
      }
      promptCacheRefreshPromise = (async () => {
        try {
          await ensureReady();
          const scope = await resolveUserAndWorkspaceScope({
            api,
            pool: getPool(),
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
            configuredExternalId: cfg?.identity?.externalId,
          });
          const items = await queryPromptMemoryItems({
            pool: getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limit: 50,
            // MVP: durable injection focuses on facts and notes.
            // TODO: extend prompt injection policy for other types:
            // profile/config/skill/summary/automation (safe ordering + size budgets + canonicalKey conventions).
            types: ["fact", "note"],
          });
          promptCacheLines = buildPromptMemorySection({
            items,
            maxTotalChars: 12_000,
            maxTitleChars: 120,
            policy: {
              // MVP: durable injection focuses on facts and notes.
              maxItemsByType: { fact: 6, note: 4 },
              defaultMaxItemChars: 1_200,
            },
          });
          promptCacheError = null;
        } catch (error) {
          promptCacheLines = null;
          promptCacheError = error instanceof Error ? error.message : String(error);
          api.logger.warn(`anchorclaw: prompt cache refresh failed (${promptCacheError})`);
        } finally {
          promptCacheRefreshPromise = null;
        }
      })();
    };
    const ensureSessionsIndexBootstrapped = async () => {
      if (!cfg) {
        return;
      }
      if ((cfg.sessions?.visibility ?? "current") === "off") {
        return;
      }
      if (sessionsIndexBootstrapPromise) {
        await sessionsIndexBootstrapPromise;
        return;
      }
      sessionsIndexBootstrapPromise = (async () => {
        try {
          await ensureReady();
          const scope = await resolveUserAndWorkspaceScope({
            api,
            pool: getPool(),
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
            configuredExternalId: cfg?.identity?.externalId,
          });
          await syncSessionsIndexDb({
            pool: getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            agentId: String((api as any)?.runtime?.agentId ?? "main"),
          });
        } catch (error) {
          api.logger.warn(
            `anchorclaw: sessions index bootstrap failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      })();
      await sessionsIndexBootstrapPromise;
    };

    api.logger.info(
      cfg
        ? `anchorclaw: plugin registered (db: ${cfg.postgres.host}, lazy init)`
        : "anchorclaw: plugin registered (disabled until configured)",
    );

    // Best-effort warm-up so the very first prompt often has durable memory available.
    if (cfg) {
      refreshPromptCache();
    }

    // Best-effort one-time import of legacy memory files from the workspace into Postgres.
    // This does not remove/disable file-based behavior in OpenClaw core; it only populates DB state.
    if (cfg) {
      (async () => {
        try {
          await ensureReady();
          const workspaceDir =
            typeof (api as any)?.runtime?.workspaceDir === "string" && (api as any).runtime.workspaceDir.trim()
              ? String((api as any).runtime.workspaceDir)
              : process.cwd();
          await runOneTimeWorkspaceImport({
            api,
            cfg,
            pool: getPool(),
            workspaceDir,
            agentId: (api as any)?.runtime?.agentId,
            sessionKey: (api as any)?.runtime?.sessionKey,
          });
        } catch (error) {
          api.logger.warn(
            `anchorclaw: workspace import failed (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      })();
    }

    registerMemoryCapability("anchorclaw", {
      promptBuilder: (params?: { availableTools: Set<string>; citationsMode?: "off" | "inline" | "block" | string }) => {
        if (disabledReason) {
          return [`AnchorClaw memory is disabled until configured (${disabledReason}).`];
        }

        if (!promptCacheLines && !promptCacheError) {
          refreshPromptCache();
        }
        const cached = promptCacheLines ?? [];
        const cacheNotice = promptCacheError
          ? [`[AnchorClaw durable memory cache unavailable: ${promptCacheError}]`, ""]
          : cached.length === 0
            ? ["[AnchorClaw durable memory cache is warming up...]", ""]
            : [];

        const hasMemorySearch = Boolean(params?.availableTools?.has?.("memory_search"));
        const hasMemoryGet = Boolean(params?.availableTools?.has?.("memory_get"));

        let toolGuidance = "";
        if (hasMemorySearch && hasMemoryGet) {
          toolGuidance =
            "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.";
        } else if (hasMemorySearch) {
          toolGuidance =
            "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search and answer from matching results. If low confidence after search, say you checked.";
        } else if (hasMemoryGet) {
          toolGuidance =
            "Before answering anything about prior work, decisions, dates, people, preferences, or todos that already point to a specific memory item: run memory_get to pull only the needed lines. If low confidence after reading them, say you checked.";
        }

        const citationsMode = params?.citationsMode ?? "inline";
        const citationsLine =
          citationsMode === "off"
            ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
            : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";

        return [
          "AnchorClaw durable memory is enabled (Postgres-backed).",
          "",
          ...(toolGuidance ? ["## Memory Recall", toolGuidance, citationsLine, ""] : []),
          "MVP usage rules:",
          "- Save durable memory with memory_store({ content, canonicalKey?, type? }).",
          "- Use canonicalKey only for updateable facts/preferences/settings (so updates overwrite instead of duplicating).",
          "- Find memory with memory_search({ query, corpus? }).",
          "- Read items with memory_get({ lookup: \"db-memory/items/<uuid>.md\" | \"sessions/<agentId>/<file>\", fromLine?, lineCount? }).",
          "- Shortcut recall: memory_recall({ query? }) (without query returns top important recent items).",
          "- Forget items with memory_forget({ lookup }) or memory_forget({ id }).",
          "",
          "Notes:",
          "- memory_search supports corpus=\"memory\" (Postgres durable), corpus=\"sessions\" (best-effort transcript search), and corpus=\"all\" (merge). corpus=\"wiki\" is deferred; use wiki_search/wiki_get when installed.",
          "",
          ...cacheNotice,
          ...cached,
        ];
      },
      runtime: {
        async getMemorySearchManager(params: { cfg: any; agentId: string; purpose?: "default" | "status" | "cli" }) {
          if (disabledReason) {
            return {
              manager: null,
              error: `anchorclaw: disabled until configured (${disabledReason})`,
            };
          }
          getPool();
          return {
            manager: createAnchorClawMemorySearchManager(({
              api,
              cfg: cfg!,
              ensureReady,
              getPool,
              agentId: params.agentId,
              purpose: params.purpose,
            } satisfies AnchorClawMemorySearchManagerOptions)),
          };
        },
        resolveMemoryBackendConfig(_params: { cfg: any; agentId: string }) {
          return { backend: "builtin" as const };
        },
      },
    });

    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search memory.\n\nMVP rules:\n- corpus defaults to \"memory\" (durable items in Postgres).\n- corpus=\"sessions\" performs a best-effort search over session transcripts on disk and returns paths like sessions/<agentId>/<session>.jsonl...\n- Results contain synthetic paths. Use memory_get to read them.",
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
        if (disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${disabledReason})` }],
            details: { disabled: true, error: disabledReason },
          };
        }
        await ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: cfg?.identity?.externalId,
        });
        const limits = resolveMemoryLimits(cfg!);
        const record = (params ?? {}) as any;
        const query = typeof record.query === "string" ? String(record.query) : "";
        const corpus = typeof record.corpus === "string" ? String(record.corpus) : "memory";
        const maxResults = typeof record.maxResults === "number" ? (record.maxResults as number) : undefined;
        const minScore = typeof record.minScore === "number" ? (record.minScore as number) : undefined;
        const effectiveMax = typeof maxResults === "number" ? maxResults : limits.maxResults;
        const trimmedCorpus = corpus.trim();
        const sessionsVisibility = cfg?.sessions?.visibility ?? "current";
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
        if (trimmedCorpus === "sessions") {
          if (!sessionsEnabled) {
            return {
              content: [{ type: "text", text: "anchorclaw: sessions corpus is disabled by config (sessions.visibility=off)" }],
              details: { disabled: true, error: "sessions corpus disabled", visibility: sessionsVisibility },
            };
          }
          await ensureSessionsIndexBootstrapped();
          const indexedHits = await memorySearchSessionsIndexDb({
            pool: getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limits,
            query,
            maxResults: effectiveMax,
          });
          hits =
            indexedHits.length > 0
              ? indexedHits
              : await memorySearchSessions({
                  query,
                  maxResults: effectiveMax,
                  agentId: (api as any)?.runtime?.agentId,
                  limits,
                });
        } else if (trimmedCorpus === "memory") {
          hits = await memorySearchDb({
            pool: getPool(),
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
              pool: getPool(),
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              limits,
              query,
              maxResults: effectiveMax,
            })),
            ...(sessionsEnabled
              ? await memorySearchSessionsIndexDb({
                  pool: getPool(),
                  userId: scope.userId,
                  workspaceId: scope.workspaceId,
                  limits,
                  query,
                  maxResults: effectiveMax,
                })
              : []),
          ];
          if (sessionsEnabled) {
            const hasSessionsHits = merged.some((item: any) => item?.corpus === "sessions");
            if (!hasSessionsHits) {
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
          merged.sort((left: any, right: any) => {
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
          hits = merged.slice(0, effectiveMax);
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
          details: { results: hits, count: hits.length },
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
        if (disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${disabledReason})` }],
            details: { disabled: true, error: disabledReason },
          };
        }
        await ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: cfg?.identity?.externalId,
        });
        const limits = resolveMemoryLimits(cfg!);
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
        const sessionsVisibility = cfg?.sessions?.visibility ?? "current";
        if (sessionsVisibility === "off" && lookup.trim().startsWith("sessions/")) {
          return {
            content: [{ type: "text", text: "anchorclaw: sessions corpus is disabled by config (sessions.visibility=off)" }],
            details: { disabled: true, error: "sessions corpus disabled", visibility: sessionsVisibility },
          };
        }
        const got = await memoryGetFromDb({
          pool: getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: (api as any)?.runtime?.agentId,
          workspaceDir:
            typeof (api as any)?.runtime?.workspaceDir === "string" && (api as any).runtime.workspaceDir.trim()
              ? String((api as any).runtime.workspaceDir)
              : process.cwd(),
          limits,
          lookup,
          ...(typeof fromLine === "number" ? { fromLine } : {}),
          ...(typeof lineCount === "number" ? { lineCount } : {}),
        });
        if (!got.ok) {
          return {
            content: [{ type: "text", text: `anchorclaw: memory_get failed (${got.error})` }],
            details: got,
          };
        }
        return {
          content: [{ type: "text", text: got.content }],
          details: got,
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
        if (disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${disabledReason})` }],
            details: { disabled: true, error: disabledReason },
          };
        }
        await ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: cfg?.identity?.externalId,
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
          pool: getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          actor: resolveActor(api),
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
        if (disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${disabledReason})` }],
            details: { disabled: true, error: disabledReason },
          };
        }
        await ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: cfg?.identity?.externalId,
        });
        const limits = resolveMemoryLimits(cfg!);
        const recalled = await memoryRecallDb({
          pool: getPool(),
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
        if (disabledReason) {
          return {
            content: [{ type: "text", text: `anchorclaw: disabled until configured (${disabledReason})` }],
            details: { disabled: true, error: disabledReason },
          };
        }
        await ensureReady();
        const scope = await resolveUserAndWorkspaceScope({
          api,
          pool: getPool(),
          agentId: (api as any)?.runtime?.agentId,
          sessionKey: (api as any)?.runtime?.sessionKey,
          configuredExternalId: cfg?.identity?.externalId,
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
          pool: getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          actor: resolveActor(api),
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
