import { resolveUserAndWorkspaceScope } from "../../identity.js";
import { resolveMemoryLimits } from "../../memory/limits.js";
import { memorySearchDb } from "../../memory/search.js";
import { memorySearchSessions } from "../../memory/sessions.js";
import { hasSessionsIndexRows, memorySearchSessionsIndexDb } from "../../memory/sessions-index.js";
import { filterSessionHitsByVisibility } from "../../memory/sessions-visibility.js";
import type { ToolRegistrationParams } from "./common.js";

export function registerMemorySearchTool({
  ctx,
  ensureSessionsIndexBootstrapped,
}: ToolRegistrationParams) {
  const api = ctx.api;
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
}
