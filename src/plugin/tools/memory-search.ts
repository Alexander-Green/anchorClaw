import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { scanLegacyWorkspace } from "../../importer.js";
import { resolveSessionsSearchState } from "../../config.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { memorySearchDailyDb, memorySearchDb } from "../../memory/search.js";
import { memorySearchSessions } from "../../memory/sessions.js";
import { hasSessionsIndexRows, memorySearchSessionsIndexDb } from "../../memory/sessions-index.js";
import { filterSessionHitsByVisibility } from "../../memory/sessions-visibility.js";
import { resolveConfiguredWorkspaceDir, WORKSPACE_DIR_UNAVAILABLE } from "../../workspace.js";
import {
  getToolUnavailableResponse,
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

async function buildLegacyImportWarning(params: {
  ctx: ToolRegistrationParams["ctx"];
  api: any;
  corpus: string;
}): Promise<string | null> {
  if (params.corpus !== "memory" && params.corpus !== "all") {
    return null;
  }
  const workspaceDir = resolveConfiguredWorkspaceDir(params.ctx.cfg);
  if (!workspaceDir || !params.ctx.cfg) {
    return null;
  }
  try {
    const legacyScan = await scanLegacyWorkspace({
      api: params.api,
      cfg: params.ctx.cfg,
      pool: params.ctx.getPool(),
      workspaceDir,
      agentId: (params.api as any)?.runtime?.agentId,
      sessionKey: (params.api as any)?.runtime?.sessionKey,
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
}: ToolRegistrationParams) {
  const api = ctx.api;
  api.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search memory.\n\nBehavior contract:\n- corpus defaults to \"memory\" (durable items plus DB-backed daily memory).\n- For corpus=\"memory\", retrieval is lexical Postgres FTS (tsquery/ts_rank), not vector semantic retrieval.\n- corpus=\"daily\" searches DB-backed daily memory only.\n- corpus=\"sessions\" uses Postgres-backed sessions index (DB-first), returns paths like sessions/<agentId>/<session>.jsonl, and is opt-in via sessions.search.enabled=true.\n- Results contain synthetic paths. Use memory_get to read them.\n- If the top result is an exact literal match, content includes \"Top exact match: <value>\" and details.meta.exactTop1/exactTop1Value.\n- Do not claim semantic/vector retrieval unless details.meta explicitly reports it in a future implementation.",
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
      const unavailable = getToolUnavailableResponse(ctx);
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
      let retrievalMode: "fts_memory" | "fts_daily" | "sessions_index" | "sessions_fallback" | "all_merge_lexical" = "fts_memory";
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
        const workspaceDir = resolveConfiguredWorkspaceDir(ctx.cfg);
        if (!workspaceDir) {
          return {
            content: [{ type: "text", text: `anchorclaw: memory_search unavailable (${WORKSPACE_DIR_UNAVAILABLE})` }],
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
            retrievalMode = "sessions_index";
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
            retrievalMode = hasIndex ? "sessions_index" : "sessions_fallback";
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
          retrievalMode = "fts_memory";
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
          retrievalMode = "all_merge_lexical";
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
      const legacyImportWarning =
        hits.length === 0
          ? await buildLegacyImportWarning({
              ctx,
              api,
              corpus: trimmedCorpus,
            })
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
          visible: visibleDetails,
          results: hits,
          count: hits.length,
          meta: {
            retrievalMode,
            queryMode,
            semantic: false,
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
  });
}
