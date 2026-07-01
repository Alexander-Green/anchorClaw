import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { scanLegacyWorkspace } from "../../importer.js";
import { resolveSessionsSearchState } from "../../config.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import {
  memorySearchDailyDb,
  memorySearchDb,
  memorySearchSemanticDb,
  type MemorySearchHit,
} from "../../memory/search.js";
import { memorySearchSessions } from "../../memory/sessions.js";
import { hasSessionsIndexRows, memorySearchSessionsIndexDb } from "../../memory/sessions-index.js";
import { filterSessionHitsByVisibility } from "../../memory/sessions-visibility.js";
import {
  countMissingSemanticEmbeddings,
  enqueueSemanticIndexingRequest,
  indexMissingSemanticEmbeddings,
} from "../../semantic/indexing.js";
import {
  buildSemanticEmbedding,
  resolveSemanticRuntimeProfile,
  type SemanticRuntimeProfile,
} from "../../semantic/runtime.js";
import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
  type ToolRegistrationParams,
} from "./common.js";
import { buildSearchLikeDetailsEnvelope, formatSearchLikeVisibleOutput } from "./memory-visible-output.js";

function normalizeExact(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function classifyQueryMode(query: string): "exact_value" | "contextual" {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return "contextual";
  }
  const broadSignals = [
    "summarize",
    "summary",
    "overview",
    "around",
    "what values",
    "какие",
    "кратко",
    "обзор",
    "сгруппируй",
    "вокруг",
  ];
  if (broadSignals.some((signal) => normalized.includes(signal))) {
    return "contextual";
  }
  const exactSignals = [
    "exact",
    "top-1",
    "only",
    "value only",
    "string only",
    "id",
    "key",
    "marker",
    "token",
    "uuid",
    "login",
    "точн",
    "только",
    "значени",
  ];
  return exactSignals.some((signal) => normalized.includes(signal)) ? "exact_value" : "contextual";
}

function isMarkerLike(value: string): boolean {
  const text = value.trim();
  if (!text) {
    return false;
  }
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+){2,}$/.test(text)) {
    return true;
  }
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    return true;
  }
  if (/^@\w{3,}$/.test(text)) {
    return true;
  }
  return /^[0-9]{6,}$/.test(text);
}

function markerBoostForHit(hit: any): number {
  const title = typeof hit?.title === "string" ? hit.title : "";
  const snippet = typeof hit?.snippet === "string" ? hit.snippet : "";
  return isMarkerLike(title) || isMarkerLike(snippet) ? 2 : 0;
}

type SemanticSearchMeta = {
  enabled: boolean;
  profile?: SemanticRuntimeProfile;
  profileKey?: string;
  queryEmbedded?: boolean;
  inlineAttempted?: number;
  inlineIndexed?: number;
  backlog?: number;
  queued?: boolean;
  queueError?: string;
  error?: string;
};

function runtimeConfigFromToolContext(toolCtx: OpenClawPluginToolContext): unknown {
  const getRuntimeConfig = (toolCtx as any).getRuntimeConfig;
  return toolCtx.runtimeConfig ?? (typeof getRuntimeConfig === "function" ? getRuntimeConfig() : undefined);
}

function mergeMemoryHits(params: {
  lexicalHits: MemorySearchHit[];
  semanticHits: MemorySearchHit[];
  limit: number;
}): MemorySearchHit[] {
  if (params.semanticHits.length === 0) {
    return params.lexicalHits.slice(0, params.limit);
  }

  const rrfK = 60;
  const merged = new Map<string, { hit: MemorySearchHit; score: number }>();
  const addHits = (hits: MemorySearchHit[], weight: number) => {
    hits.forEach((hit, index) => {
      const key = hit.id ?? hit.path;
      const contribution = weight / (rrfK + index + 1);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, { hit, score: contribution });
        return;
      }
      previous.score += contribution;
      if (hit.score > previous.hit.score) {
        previous.hit = hit;
      }
    });
  };

  addHits(params.lexicalHits, 1);
  addHits(params.semanticHits, 1);

  return Array.from(merged.values())
    .map(({ hit, score }) => ({ ...hit, score }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, params.limit);
}

async function trySemanticMemorySearch(params: {
  ctx: ToolRegistrationParams["ctx"];
  runtimeConfig: unknown;
  agentId: string;
  userId: string;
  workspaceId: string;
  query: string;
  limits: ReturnType<typeof resolveMemoryLimits>;
  maxResults: number;
}): Promise<{ hits: MemorySearchHit[]; meta: SemanticSearchMeta }> {
  const { profile } = resolveSemanticRuntimeProfile({
    cfg: params.ctx.cfg,
    runtimeConfig: params.runtimeConfig,
    agentId: params.agentId,
  });
  const meta: SemanticSearchMeta = {
    enabled: profile.enabled,
    profile,
    ...(profile.profileKey ? { profileKey: profile.profileKey } : {}),
  };

  if (!profile.enabled) {
    return { hits: [], meta };
  }
  if (!profile.profileKey) {
    meta.error = profile.error ?? "semantic profile key is unavailable";
    params.ctx.api.logger.warn(`anchorclaw: semantic search unavailable (${meta.error})`);
    return { hits: [], meta };
  }

  async function queue(reason: string): Promise<void> {
    const queued = await enqueueSemanticIndexingRequest({
      pool: params.ctx.getPool(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      profileKey: profile.profileKey!,
      reason,
    });
    meta.queued = queued.queued;
    if (queued.error) {
      meta.queueError = queued.error;
      params.ctx.api.logger.warn(
        `anchorclaw: semantic indexing request could not be queued (${queued.error})`,
      );
    }
  }

  try {
    const queryEmbedding = await buildSemanticEmbedding({
      cfg: params.ctx.cfg,
      runtimeConfig: params.runtimeConfig,
      agentId: params.agentId,
      text: params.query,
      purpose: "query",
      timeoutMs: 5_000,
    });
    if (!queryEmbedding) {
      return { hits: [], meta };
    }
    meta.queryEmbedded = true;

    let semanticHits = await memorySearchSemanticDb({
      pool: params.ctx.getPool(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      profileKey: queryEmbedding.profileKey,
      queryVector: queryEmbedding.vector,
      limits: params.limits,
      maxResults: params.maxResults,
    });

    let backlog = await countMissingSemanticEmbeddings({
      pool: params.ctx.getPool(),
      userId: params.userId,
      workspaceId: params.workspaceId,
      profileKey: queryEmbedding.profileKey,
      expectedDimensions: queryEmbedding.dimensions,
    });
    meta.backlog = backlog;

    if (backlog > 0) {
      const batch = await indexMissingSemanticEmbeddings({
        pool: params.ctx.getPool(),
        cfg: params.ctx.cfg,
        runtimeConfig: params.runtimeConfig,
        userId: params.userId,
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        limit: Math.min(5, params.maxResults),
        expectedDimensions: queryEmbedding.dimensions,
        timeoutMs: 5_000,
        logger: params.ctx.api.logger,
      });
      meta.inlineAttempted = batch.attempted;
      meta.inlineIndexed = batch.indexed;
      meta.backlog = batch.remaining;
      if (batch.error) {
        meta.error = batch.error;
        await queue("inline_indexing_failed");
      } else if (batch.indexed > 0) {
        semanticHits = await memorySearchSemanticDb({
          pool: params.ctx.getPool(),
          userId: params.userId,
          workspaceId: params.workspaceId,
          profileKey: queryEmbedding.profileKey,
          queryVector: queryEmbedding.vector,
          limits: params.limits,
          maxResults: params.maxResults,
        });
      }
      if ((meta.backlog ?? 0) > 0) {
        await queue("search_missing");
      }
    }

    return { hits: semanticHits, meta };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    meta.error = message;
    params.ctx.api.logger.warn(`anchorclaw: semantic search skipped (${message})`);
    await queue("semantic_search_failed");
    return { hits: [], meta };
  }
}

async function buildLegacyImportWarning(params: {
  ctx: ToolRegistrationParams["ctx"];
  api: any;
  corpus: string;
  workspaceDir: string;
  agentId: string;
  sessionKey?: string;
}): Promise<string | null> {
  if (params.corpus !== "memory" && params.corpus !== "all") {
    return null;
  }
  if (!params.ctx.cfg) {
    return null;
  }
  try {
    const legacyScan = await scanLegacyWorkspace({
      api: params.api,
      cfg: params.ctx.cfg,
      pool: params.ctx.getPool(),
      sourceDir: params.workspaceDir,
      targetWorkspaceDir: params.workspaceDir,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    });
    if (!legacyScan.hasActiveLegacy) {
      return null;
    }
    return "Legacy memory import is still pending, so missing DB results do not prove the memory does not exist.";
  } catch {
    return null;
  }
}

export function registerMemorySearchTool({
  ctx,
  ensureSessionsIndexBootstrapped,
  ensureStartupBootstrap,
}: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool((toolCtx: OpenClawPluginToolContext) => ({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search memory.\n\nBehavior contract:\n- corpus defaults to \"memory\" (durable items plus DB-backed daily memory).\n- For corpus=\"memory\", retrieval starts with lexical Postgres FTS (tsquery/ts_rank). When AnchorClaw semantic is enabled and the active OpenClaw agent has memorySearch provider/model, durable memory_items also use vector semantic retrieval.\n- corpus=\"daily\" searches DB-backed daily memory only.\n- corpus=\"sessions\" uses Postgres-backed sessions index (DB-first), returns paths like sessions/<agentId>/<session>.jsonl, and is opt-in via sessions.search.enabled=true.\n- Semantic retrieval only covers durable memory_items, not daily or sessions.\n- Results contain synthetic paths. Use memory_get to read them.\n- If the top result is an exact literal match, content includes \"Top exact match: <value>\" and details.meta.exactTop1/exactTop1Value.\n- Do not claim semantic/vector retrieval unless details.meta.semantic.enabled is true.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query text." },
        corpus: {
          type: "string",
          description: "Memory corpus (memory|daily|sessions|all). Defaults to memory.",
          enum: ["memory", "daily", "sessions", "all", "wiki"],
        },
        maxResults: { type: "number", description: "Max results (capped by configured limits)." },
        minScore: { type: "number", description: "Optional minimum score threshold." },
      },
    },
    async execute(_toolCallId: string, params: unknown) {
      if (
        (ctx.durableState?.overall === "pending" ||
          (ctx.durableState?.overall === "blocked" &&
            ctx.durableState?.import === "failed_retryable")) &&
        typeof ensureStartupBootstrap === "function"
      ) {
        await ensureStartupBootstrap();
      }
      const blockedReason = ctx.durableState?.reason ?? ctx.startupCriticalFailure ?? null;
      if (
        ctx.durableState?.overall === "blocked" &&
        typeof blockedReason === "string" &&
        blockedReason.includes("migrations_failed:")
      ) {
        return {
          content: [{ type: "text", text: `anchorclaw: memory_search degraded (${blockedReason})` }],
          details: {
            disabled: true,
            error: blockedReason,
            degraded: true,
            degradedReason: "migrations_failed",
            sdk: { ...ctx.sdkHealth },
          },
        };
      }
      const unavailable = await ensureToolRuntimeReady(ctx, ensureStartupBootstrap);
      if (unavailable) return unavailable;
      const record = (params ?? {}) as any;
      const query = typeof record.query === "string" ? String(record.query) : "";
      const corpus = typeof record.corpus === "string" ? String(record.corpus) : "memory";
      const maxResults = typeof record.maxResults === "number" ? (record.maxResults as number) : undefined;
      const minScore = typeof record.minScore === "number" ? (record.minScore as number) : undefined;
      const trimmedCorpus = corpus.trim();
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
      const sessionsSearch = resolveSessionsSearchState(ctx.cfg);
      const sessionsVisibility = sessionsSearch.visibility;
      const sessionsEnabled = sessionsSearch.effective;
      let hits: any[] = [];
      let retrievalMode:
        | "fts_memory"
        | "hybrid_memory"
        | "fts_daily"
        | "sessions_index"
        | "sessions_fallback"
        | "all_merge_lexical"
        | "all_merge_hybrid" = "fts_memory";
      let semanticMeta: SemanticSearchMeta = { enabled: false };
      try {
        await ctx.ensureReady();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const degradedReason = message.startsWith("migrations_failed:")
          ? message
          : `migrations_failed: ${message}`;
        ctx.setDurableState({
          overall: "blocked",
          migrations: "failed",
          reason: degradedReason,
        });
        ctx.setStartupCriticalFailure(degradedReason);
        ctx.markSdkError(`memory_search:${trimmedCorpus || "unknown"}`, error);
        return {
          content: [{ type: "text", text: `anchorclaw: memory_search degraded (${degradedReason})` }],
          details: {
            disabled: true,
            error: degradedReason,
            degraded: true,
            degradedReason: "migrations_failed",
            sdk: { ...ctx.sdkHealth },
          },
        };
      }
      try {
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
        const effectiveMax = typeof maxResults === "number" ? maxResults : limits.maxResults;
        if (trimmedCorpus === "sessions") {
          if (!sessionsEnabled) {
            const visible = formatSearchLikeVisibleOutput({
              hits: [],
              retrievalMode: "sessions_disabled",
              queryMode: classifyQueryMode(query),
              exactTop1: false,
              exactTop1Value: null,
              recommendedAction: "stop_not_found",
              provider: "anchorclaw",
              model: "postgres-fts",
            });
            return {
              content: [{ type: "text", text: visible }],
              details: {
                visible: buildSearchLikeDetailsEnvelope({
                  hits: [],
                  retrievalMode: "sessions_disabled",
                  queryMode: classifyQueryMode(query),
                  exactTop1: false,
                  exactTop1Value: null,
                  recommendedAction: "stop_not_found",
                  provider: "anchorclaw",
                  model: "postgres-fts",
                }),
                results: [],
                count: 0,
                meta: {
                  retrievalMode: "sessions_disabled",
                  queryMode: classifyQueryMode(query),
                  semantic: false,
                  exactTop1: false,
                  exactTop1Value: null,
                  recommendedAction: "stop_not_found",
                  sessions: {
                    configured: sessionsSearch.configured,
                    effective: sessionsSearch.effective,
                    visibility: sessionsSearch.visibility,
                    ...(sessionsSearch.reason ? { reason: sessionsSearch.reason } : {}),
                  },
                },
              },
            };
          }
          await ensureSessionsIndexBootstrapped(workspaceTarget);
          const indexedHits = await memorySearchSessionsIndexDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limits,
            query,
            maxResults: effectiveMax,
            ...(sessionsVisibility === "current" ? { currentAgentId: workspaceTarget.agentId } : {}),
          });
          if (indexedHits.length > 0) {
            hits = indexedHits;
            retrievalMode = "sessions_index";
          } else {
            const hasIndex = await hasSessionsIndexRows({
              pool: ctx.getPool(),
              userId: scope.userId,
              workspaceId: scope.workspaceId,
              ...(sessionsVisibility === "current" ? { currentAgentId: workspaceTarget.agentId } : {}),
            });
            hits = hasIndex
              ? []
              : await memorySearchSessions({
                  query,
                  maxResults: effectiveMax,
                  agentId: workspaceTarget.agentId,
                  limits,
                });
            retrievalMode = hasIndex ? "sessions_index" : "sessions_fallback";
          }
          hits = await filterSessionHitsByVisibility({
            api,
            runtimeConfig: toolCtx.runtimeConfig,
            getRuntimeConfig: toolCtx.getRuntimeConfig,
            sessionKey: toolCtx.sessionKey,
            sandboxed: (toolCtx as any).sandboxed,
            hits,
          });
        } else if (trimmedCorpus === "memory") {
          const lexicalHits = await memorySearchDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limits,
            query,
            ...(typeof maxResults === "number" ? { maxResults } : {}),
          });
          const semanticSearch = await trySemanticMemorySearch({
            ctx,
            runtimeConfig: runtimeConfigFromToolContext(toolCtx),
            agentId: workspaceTarget.agentId,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            query,
            limits,
            maxResults: effectiveMax,
          });
          semanticMeta = semanticSearch.meta;
          hits = mergeMemoryHits({
            lexicalHits,
            semanticHits: semanticSearch.hits,
            limit: effectiveMax,
          });
          retrievalMode = semanticSearch.hits.length > 0 ? "hybrid_memory" : "fts_memory";
        } else if (trimmedCorpus === "daily") {
          hits = await memorySearchDailyDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limits,
            query,
            ...(typeof maxResults === "number" ? { maxResults } : {}),
          });
          retrievalMode = "fts_daily";
        } else if (trimmedCorpus === "all") {
          if (sessionsEnabled) {
            await ensureSessionsIndexBootstrapped(workspaceTarget);
          }
          const lexicalMemoryHits = await memorySearchDb({
            pool: ctx.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            limits,
            query,
            maxResults: effectiveMax,
          });
          const semanticSearch = await trySemanticMemorySearch({
            ctx,
            runtimeConfig: runtimeConfigFromToolContext(toolCtx),
            agentId: workspaceTarget.agentId,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            query,
            limits,
            maxResults: effectiveMax,
          });
          semanticMeta = semanticSearch.meta;
          const memoryHits = mergeMemoryHits({
            lexicalHits: lexicalMemoryHits,
            semanticHits: semanticSearch.hits,
            limit: effectiveMax,
          });
          const merged = [
            ...memoryHits,
            ...(sessionsEnabled
              ? await memorySearchSessionsIndexDb({
                  pool: ctx.getPool(),
                  userId: scope.userId,
                  workspaceId: scope.workspaceId,
                  limits,
                  query,
                  maxResults: effectiveMax,
                  ...(sessionsVisibility === "current" ? { currentAgentId: workspaceTarget.agentId } : {}),
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
                ...(sessionsVisibility === "current" ? { currentAgentId: workspaceTarget.agentId } : {}),
              });
              if (!hasIndex) {
                merged.push(
                  ...(await memorySearchSessions({
                    query,
                    maxResults: effectiveMax,
                    agentId: workspaceTarget.agentId,
                    limits,
                  })),
                );
              }
            }
          }
          const mergedForOutput = sessionsEnabled
            ? await filterSessionHitsByVisibility({
                api,
                runtimeConfig: toolCtx.runtimeConfig,
                getRuntimeConfig: toolCtx.getRuntimeConfig,
                sessionKey: toolCtx.sessionKey,
                sandboxed: (toolCtx as any).sandboxed,
                hits: merged,
              })
            : merged;
          mergedForOutput.sort((left: any, right: any) => {
            const ls = typeof left?.score === "number" ? left.score : 0;
            const rs = typeof right?.score === "number" ? right.score : 0;
            if (rs !== ls) {
              return rs - ls;
            }
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
          retrievalMode = semanticSearch.hits.length > 0 ? "all_merge_hybrid" : "all_merge_lexical";
        }
        ctx.markSdkSuccess();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.markSdkError(`memory_search:${trimmedCorpus || "unknown"}`, error);
        return {
          content: [{ type: "text", text: `anchorclaw: memory_search degraded (${message})` }],
          details: {
            disabled: true,
            error: message,
            degraded: true,
            degradedReason: "sdk_error",
            sdk: { ...ctx.sdkHealth },
          },
        };
      }

      if (trimmedCorpus !== "memory" && trimmedCorpus !== "daily" && trimmedCorpus !== "sessions" && trimmedCorpus !== "all") {
        return {
          content: [{ type: "text", text: `anchorclaw: unsupported corpus (${trimmedCorpus || "empty"})` }],
          details: { disabled: true, error: "unsupported corpus", corpus: trimmedCorpus },
        };
      }

      if (typeof minScore === "number" && Number.isFinite(minScore)) {
        hits = hits.filter((hit: any) => typeof hit?.score === "number" && hit.score >= minScore);
      }
      const normalizedQuery = normalizeExact(query);
      const queryMode = classifyQueryMode(query);
      if (queryMode === "exact_value") {
        hits.sort((left: any, right: any) => {
          const ls = (typeof left?.score === "number" ? left.score : 0) + markerBoostForHit(left);
          const rs = (typeof right?.score === "number" ? right.score : 0) + markerBoostForHit(right);
          if (rs !== ls) {
            return rs - ls;
          }
          const lp = typeof left?.path === "string" ? left.path : "";
          const rp = typeof right?.path === "string" ? right.path : "";
          return lp.localeCompare(rp);
        });
      }
      const topHit = hits[0] as any;
      const topTitle = normalizeExact(topHit?.title);
      const topSnippet = normalizeExact(topHit?.snippet);
      const exactTop1 = Boolean(
        normalizedQuery &&
          topHit &&
          (topTitle === normalizedQuery || topSnippet === normalizedQuery),
      );
      const exactTop1Value = exactTop1
        ? (typeof topHit?.title === "string" && topHit.title.trim()) ||
          (typeof topHit?.snippet === "string" && topHit.snippet.trim()) ||
          null
        : null;
      const recommendedAction = exactTop1 ? "return_exact" : hits.length > 0 ? "inspect_top" : "stop_not_found";
      const visible = formatSearchLikeVisibleOutput({
        hits,
        retrievalMode,
        queryMode,
        exactTop1,
        exactTop1Value,
        recommendedAction,
        provider: "anchorclaw",
        model: "postgres-fts",
      });
      const visibleDetails = buildSearchLikeDetailsEnvelope({
        hits,
        retrievalMode,
        queryMode,
        exactTop1,
        exactTop1Value,
        recommendedAction,
        provider: "anchorclaw",
        model: "postgres-fts",
      });
      const semanticDetails = semanticMeta.enabled ? semanticMeta : false;
      const visibleDetailsWithSemantic = {
        ...visibleDetails,
        meta: {
          ...visibleDetails.meta,
          semantic: semanticDetails,
        },
      };
      const legacyImportWarning =
        hits.length === 0
          ? await (async () => {
              const legacyWorkspaceTarget = resolveRuntimeToolWorkspace({
                ctx,
                runtimeConfig: toolCtx.runtimeConfig,
                getRuntimeConfig: toolCtx.getRuntimeConfig,
                workspaceDir: toolCtx.workspaceDir,
                agentId: toolCtx.agentId,
                sessionKey: toolCtx.sessionKey,
                sessionId: toolCtx.sessionId,
              });
              if ("content" in legacyWorkspaceTarget) {
                return null;
              }
              return buildLegacyImportWarning({
                ctx,
                api,
                corpus: trimmedCorpus,
                workspaceDir: legacyWorkspaceTarget.workspaceDir,
                agentId: legacyWorkspaceTarget.agentId,
                sessionKey: legacyWorkspaceTarget.sessionKey,
              });
            })()
          : null;
      const text = legacyImportWarning ? `${visible}\n\n${legacyImportWarning}` : visible;
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        details: {
          visible: visibleDetailsWithSemantic,
          results: hits,
          count: hits.length,
          meta: {
            retrievalMode,
            queryMode,
            semantic: semanticDetails,
            exactTop1,
            exactTop1Value,
            recommendedAction,
            ...(legacyImportWarning ? { legacyImportWarning } : {}),
            sessions: {
              configured: sessionsSearch.configured,
              effective: sessionsSearch.effective,
              visibility: sessionsSearch.visibility,
              ...(sessionsSearch.reason ? { reason: sessionsSearch.reason } : {}),
            },
          },
          ...(ctx.sdkHealth.degraded
            ? { degraded: true, degradedReason: "sdk_error", sdk: { ...ctx.sdkHealth } }
            : {}),
        },
      };
    },
  }), { name: "memory_search" });
}
