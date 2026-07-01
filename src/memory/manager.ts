import type { OpenClawPluginApi } from "../api.js";
import {
  resolveAgentMemorySearchConfig,
  resolveSemanticLayerState,
  resolveSessionsSearchState,
  type AnchorClawConfig,
} from "../config.js";
import type { PostgresPool } from "../postgres.js";
import type { SessionIndexBootstrapTarget } from "../plugin/session-delta.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { resolveMemoryLimits } from "./limits.js";
import { memoryGetFromDb } from "./get.js";
import { memorySearchDb, type MemorySearchHit } from "./search.js";
import { memorySearchSessions } from "./sessions.js";
import {
  hasSessionsIndexRows,
  memorySearchSessionsIndexDb,
} from "./sessions-index.js";
import { syncSessionsIndexDb, syncVisibleSessionsIndexDb } from "./sessions-index-sync.js";
import { canAccessSessionPathByVisibility, filterSessionHitsByVisibility } from "./sessions-visibility.js";
import {
  resolveAgentWorkspacePeerIds,
  resolveWorkspaceTargets,
} from "../workspace-targets.js";

type MemorySource = "memory" | "sessions";

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

type MemoryReadResult = {
  text: string;
  path: string;
  truncated?: boolean;
  from?: number;
  lines?: number;
  nextFrom?: number;
};

type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  dirty?: boolean;
  workspaceDir?: string;
  sources?: MemorySource[];
  sourceCounts?: Array<{ source: MemorySource; files: number; chunks: number }>;
  custom?: Record<string, unknown>;
};

type MemoryEmbeddingProbeResult = {
  ok: boolean;
  error?: string;
  checked?: boolean;
  cached?: boolean;
  checkedAtMs?: number;
  cacheExpiresAtMs?: number;
};

type MemorySearchRuntimeDebug = {
  backend: "builtin" | "qmd";
  configuredMode?: string;
  effectiveMode?: string;
  fallback?: string;
};

type MemorySyncProgressUpdate = {
  completed: number;
  total: number;
  label?: string;
};

const RUNTIME_WORKSPACE_UNAVAILABLE = "runtime_workspace_unavailable";

export type MemorySearchManager = {
  search: (
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      qmdSearchModeOverride?: "query" | "search" | "vsearch";
      onDebug?: (debug: MemorySearchRuntimeDebug) => void;
      sources?: MemorySource[];
    },
  ) => Promise<MemorySearchResult[]>;
  readFile: (params: { relPath: string; from?: number; lines?: number }) => Promise<MemoryReadResult>;
  status: () => MemoryProviderStatus;
  sync?: (params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) => Promise<void>;
  getCachedEmbeddingAvailability?: () => MemoryEmbeddingProbeResult | null;
  probeEmbeddingAvailability: () => Promise<MemoryEmbeddingProbeResult>;
  probeVectorStoreAvailability?: () => Promise<boolean>;
  probeVectorAvailability: () => Promise<boolean>;
  close?: () => Promise<void>;
};

export type AnchorClawMemorySearchManagerOptions = {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  ensureReady: () => Promise<void>;
  ensureSessionsIndexBootstrapped?: (target?: SessionIndexBootstrapTarget) => Promise<void>;
  getPool: () => PostgresPool;
  agentId: string;
  purpose?: "default" | "status" | "cli";
};

function stableScoreSort(left: MemorySearchResult, right: MemorySearchResult): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  // Prefer durable memory over sessions when equal.
  if (left.source !== right.source) {
    return left.source === "memory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function mapHitToManagerResult(hit: MemorySearchHit): MemorySearchResult {
  const source: MemorySource = hit.corpus === "sessions" ? "sessions" : "memory";
  const startLine = typeof hit.startLine === "number" && Number.isFinite(hit.startLine) && hit.startLine > 0 ? Math.floor(hit.startLine) : 1;
  const endLine =
    typeof hit.endLine === "number" && Number.isFinite(hit.endLine) && hit.endLine >= startLine
      ? Math.floor(hit.endLine)
      : startLine;
  return {
    path: hit.path,
    startLine,
    endLine,
    score: hit.score,
    snippet: hit.snippet,
    source,
    ...(typeof hit.citation === "string" && hit.citation.trim() ? { citation: hit.citation } : {}),
  };
}

export function createAnchorClawMemorySearchManager(
  params: AnchorClawMemorySearchManagerOptions,
): MemorySearchManager {
  const { api, cfg } = params;
  const sessionsSearch = resolveSessionsSearchState(cfg);
  const sessionsVisibility = sessionsSearch.visibility;
  const sessionsEnabled = sessionsSearch.effective;
  const semanticLayer = resolveSemanticLayerState(cfg);
  const resolveSemanticMemorySearch = () =>
    resolveAgentMemorySearchConfig({
      runtimeConfig: resolveRuntimeConfig(),
      agentId: params.agentId,
    });

  const resolveRuntimeConfig = (): any | undefined =>
    typeof (api as any)?.runtime?.config?.current === "function"
      ? (api as any).runtime.config.current()
      : undefined;

  const resolveWorkspaceDir = (): string | undefined => {
    const runtimeConfig = resolveRuntimeConfig();
    if (!runtimeConfig) {
      return undefined;
    }
    try {
      const [target] = resolveWorkspaceTargets({
        runtimeConfig: runtimeConfig as any,
        selector: { mode: "agent", agentId: params.agentId },
      });
      return target?.workspaceDir;
    } catch {
      return undefined;
    }
  };
  const warnWorkspaceUnavailable = (operation: "search" | "readFile" | "sync") => {
    api.logger?.warn?.(`anchorclaw: manager ${operation} skipped (${RUNTIME_WORKSPACE_UNAVAILABLE})`);
  };
  const resolveManagerSessionKey = (explicitSessionKey?: string): string | undefined => {
    const normalizedExplicit =
      typeof explicitSessionKey === "string" && explicitSessionKey.trim()
        ? explicitSessionKey.trim()
        : undefined;
    if (normalizedExplicit) {
      return normalizedExplicit;
    }
    const runtimeAgentId = String((api as any)?.runtime?.agentId ?? "").trim();
    if (!runtimeAgentId || runtimeAgentId !== params.agentId) {
      return undefined;
    }
    const runtimeSessionKey = (api as any)?.runtime?.sessionKey;
    return typeof runtimeSessionKey === "string" && runtimeSessionKey.trim()
      ? runtimeSessionKey.trim()
      : undefined;
  };

  const listVisibleAgentIds = async (): Promise<string[]> => {
    const currentAgentId = params.agentId;
    const runtimeConfig = resolveRuntimeConfig();
    if (!runtimeConfig) {
      return [currentAgentId];
    }
    try {
      return resolveAgentWorkspacePeerIds({
        runtimeConfig,
        agentId: currentAgentId,
      });
    } catch {
      return [currentAgentId];
    }
  };

  return {
    async search(query, opts) {
      const q = query.trim();
      if (!q) {
        return [];
      }
      const workspaceDir = resolveWorkspaceDir();
      if (!workspaceDir) {
        warnWorkspaceUnavailable("search");
        return [];
      }
      await params.ensureReady();
      const sessionKey = resolveManagerSessionKey(opts?.sessionKey);
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        workspaceDir,
        agentId: params.agentId,
        sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      const limits = resolveMemoryLimits(cfg);

      const requestedSources =
        Array.isArray(opts?.sources) && opts.sources.length > 0 ? opts.sources : ["memory"];
      const effectiveSources = sessionsEnabled
        ? requestedSources
        : requestedSources.filter((source) => source !== "sessions");
      const maxResults =
        typeof opts?.maxResults === "number" && Number.isFinite(opts.maxResults) ? Math.floor(opts.maxResults) : limits.maxResults;

      const results: MemorySearchResult[] = [];
      if (effectiveSources.includes("memory")) {
        const hits = await memorySearchDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          limits,
          query: q,
          maxResults,
        });
        results.push(...hits.map(mapHitToManagerResult));
      }

      if (effectiveSources.includes("sessions")) {
        if (typeof params.ensureSessionsIndexBootstrapped === "function") {
          await params.ensureSessionsIndexBootstrapped({
            workspaceDir,
            agentId: params.agentId,
            ...(sessionKey ? { sessionKey } : {}),
          });
        }
        const indexedSessionHits = await memorySearchSessionsIndexDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          limits,
          query: q,
          maxResults,
          ...(sessionsVisibility === "current" ? { currentAgentId: params.agentId } : {}),
        });
        let sessionHits = indexedSessionHits;
        if (sessionHits.length === 0) {
          const hasIndex = await hasSessionsIndexRows({
            pool: params.getPool(),
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            ...(sessionsVisibility === "current" ? { currentAgentId: params.agentId } : {}),
          });
          if (!hasIndex) {
            sessionHits = await memorySearchSessions({
              query: q,
              maxResults,
              agentId: params.agentId,
              limits,
            });
          }
        }
        const mappedSessionHits = sessionHits.map(mapHitToManagerResult);
        const filteredSessionHits = await filterSessionHitsByVisibility({
          api,
          sessionKey,
          fallbackToRuntimeSession: false,
          hits: mappedSessionHits,
        });
        results.push(...filteredSessionHits);
      }

      if (typeof opts?.onDebug === "function") {
        opts.onDebug({
          backend: "builtin",
          configuredMode: semanticLayer.enabled ? "postgres+semantic-sidecar" : "postgres",
          effectiveMode: "postgres",
        });
      }

      // Filter by minScore if provided (mostly relevant for vector search; keep behavior consistent).
      const minScore = typeof opts?.minScore === "number" && Number.isFinite(opts.minScore) ? opts.minScore : undefined;
      const filtered = minScore !== undefined ? results.filter((item) => item.score >= minScore) : results;
      return filtered.slice().sort(stableScoreSort).slice(0, maxResults);
    },

    async readFile(readParams) {
      const workspaceDir = resolveWorkspaceDir();
      if (!workspaceDir) {
        warnWorkspaceUnavailable("readFile");
        return { text: "", path: readParams.relPath };
      }
      await params.ensureReady();
      const relPath = readParams.relPath.trim();
      const sessionKey = resolveManagerSessionKey();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        workspaceDir,
        agentId: params.agentId,
        sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      const limits = resolveMemoryLimits(cfg);
      const fromLine = readParams.from ?? 1;
      const lineCount = readParams.lines ?? limits.getDefaultLines;

      if (relPath.startsWith("sessions/")) {
        if (!sessionsEnabled) {
          return { text: "", path: readParams.relPath };
        }
        const verdict = await canAccessSessionPathByVisibility({
          api,
          sessionKey,
          fallbackToRuntimeSession: false,
          path: relPath,
        });
        if (!verdict.allowed) {
          return { text: "", path: readParams.relPath };
        }
        const got = await memoryGetFromDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: params.agentId,
          sessionsVisibility,
          limits,
          lookup: relPath,
          fromLine,
          lineCount,
        });
        if (!got.ok) {
          return { text: "", path: readParams.relPath };
        }
        return {
          text: got.content,
          path: got.path,
          from: got.fromLine,
          lines: got.lineCount,
        };
      }

      if (relPath === "MEMORY.md") {
        const got = await memoryGetFromDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: params.agentId,
          sessionsVisibility,
          limits,
          lookup: "db-memory/export/MEMORY.md",
          fromLine,
          lineCount,
        });
        if (!got.ok) {
          return { text: "", path: relPath };
        }
        return {
          text: got.content,
          path: relPath,
          from: got.fromLine,
          lines: got.lineCount,
        };
      }

      if (relPath.startsWith("memory/")) {
        const got = await memoryGetFromDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: params.agentId,
          sessionsVisibility,
          limits,
          lookup: relPath,
          fromLine,
          lineCount,
        });
        if (!got.ok) {
          return { text: "", path: relPath };
        }
        return {
          text: got.content,
          path: got.path,
          from: got.fromLine,
          lines: got.lineCount,
        };
      }

      const got = await memoryGetFromDb({
        pool: params.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        agentId: params.agentId,
        sessionsVisibility,
        limits,
        lookup: readParams.relPath,
        fromLine,
        lineCount,
      });
      if (!got.ok) {
        return { text: "", path: readParams.relPath };
      }
      return {
        text: got.content,
        path: got.path,
        from: got.fromLine,
        lines: got.lineCount,
      };
    },

    status() {
      const limits = resolveMemoryLimits(cfg);
      const workspaceDir = resolveWorkspaceDir();
      const semanticMemorySearch = resolveSemanticMemorySearch();
      return {
        backend: "builtin",
        provider: "anchorclaw-postgres",
        ...(workspaceDir ? { workspaceDir } : {}),
        sources: sessionsEnabled ? ["memory", "sessions"] : ["memory"],
        custom: {
          backend: "postgres",
          postgresHost: cfg.postgres.host,
          postgresDatabase: cfg.postgres.database,
          limits,
          sessionsMaxFileBytes: limits.sessionsMaxFileBytes,
          sessionsSearchConfigured: sessionsSearch.configured,
          sessionsSearchEffective: sessionsSearch.effective,
          ...(sessionsSearch.reason ? { sessionsSearchReason: sessionsSearch.reason } : {}),
          sessionsVisibility,
          semanticConfigured: semanticLayer.configured,
          semanticEnabled: semanticLayer.enabled,
          semanticEffective: semanticLayer.effective,
          ...(semanticLayer.reason ? { semanticReason: semanticLayer.reason } : {}),
          semanticMemorySearchConfigured: semanticMemorySearch.configured,
          ...(semanticMemorySearch.source ? { semanticResolvedFrom: semanticMemorySearch.source } : {}),
          ...(semanticMemorySearch.provider ? { semanticProvider: semanticMemorySearch.provider } : {}),
          ...(semanticMemorySearch.model ? { semanticModel: semanticMemorySearch.model } : {}),
          ...(semanticMemorySearch.baseUrl ? { semanticBaseUrl: semanticMemorySearch.baseUrl } : {}),
          ...(semanticMemorySearch.configured
            ? { semanticApiKeyConfigured: semanticMemorySearch.apiKeyConfigured }
            : {}),
          purpose: params.purpose ?? "default",
          ...(!workspaceDir ? { degraded: true, error: RUNTIME_WORKSPACE_UNAVAILABLE } : {}),
        },
      };
    },

    async sync(syncParams) {
      if (!sessionsEnabled) {
        if (typeof syncParams?.progress === "function") {
          syncParams.progress({ completed: 1, total: 1, label: "sessions disabled" });
        }
        return;
      }
      const workspaceDir = resolveWorkspaceDir();
      if (!workspaceDir) {
        warnWorkspaceUnavailable("sync");
        if (typeof syncParams?.progress === "function") {
          syncParams.progress({ completed: 1, total: 1, label: "workspace unavailable" });
        }
        return;
      }
      await params.ensureReady();
      const sessionKey = resolveManagerSessionKey();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        workspaceDir,
        agentId: params.agentId,
        sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      if (typeof syncParams?.progress === "function") {
        syncParams.progress({ completed: 0, total: 1, label: "syncing sessions index" });
      }
      const sessionFiles =
        Array.isArray(syncParams?.sessionFiles) && syncParams.sessionFiles.length > 0
          ? syncParams.sessionFiles
          : undefined;
      if (!sessionFiles && sessionsVisibility === "visible") {
        const visibleAgentIds = await listVisibleAgentIds();
        await syncVisibleSessionsIndexDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: params.agentId,
          otherAgentIds: visibleAgentIds.filter((agentId) => agentId !== params.agentId),
          force: syncParams?.force === true,
        });
      } else {
        await syncSessionsIndexDb({
          pool: params.getPool(),
          userId: scope.userId,
          workspaceId: scope.workspaceId,
          agentId: params.agentId,
          force: syncParams?.force === true,
          ...(sessionFiles ? { sessionFiles } : {}),
        });
      }
      if (typeof syncParams?.progress === "function") {
        syncParams.progress({ completed: 1, total: 1, label: "done" });
      }
    },

    getCachedEmbeddingAvailability() {
      const semanticMemorySearch = resolveSemanticMemorySearch();
      if (semanticLayer.enabled && semanticMemorySearch.configured) {
        return {
          ok: true,
          cached: true,
          checked: true,
        };
      }
      return {
        ok: false,
        cached: true,
        checked: true,
        error:
          semanticLayer.enabled
            ? "semantic memorySearch provider/model not configured"
            : "semantic layer disabled",
      };
    },

    async probeEmbeddingAvailability() {
      const semanticMemorySearch = resolveSemanticMemorySearch();
      if (semanticLayer.enabled && semanticMemorySearch.configured) {
        return {
          ok: true,
          checked: true,
          checkedAtMs: Date.now(),
        };
      }
      return {
        ok: false,
        checked: true,
        checkedAtMs: Date.now(),
        error:
          semanticLayer.enabled
            ? "semantic memorySearch provider/model not configured"
            : "semantic layer disabled",
      };
    },

    async probeVectorAvailability() {
      const semanticMemorySearch = resolveSemanticMemorySearch();
      return semanticLayer.enabled && semanticMemorySearch.configured;
    },
  };
}
