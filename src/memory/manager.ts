import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import type { PostgresPool } from "../postgres.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { resolveMemoryLimits } from "./limits.js";
import { memoryGetFromDb } from "./get.js";
import { memorySearchDb, type MemorySearchHit } from "./search.js";
import { memorySearchSessions } from "./sessions.js";
import { listKnownAgentIds } from "./sessions.js";
import {
  hasSessionsIndexRows,
  memorySearchSessionsIndexDb,
} from "./sessions-index.js";
import { syncSessionsIndexDb } from "./sessions-index-sync.js";
import { canAccessSessionPathByVisibility, filterSessionHitsByVisibility } from "./sessions-visibility.js";
import { buildMemoryReadResult } from "./read-file-shared.js";
import fs from "node:fs/promises";
import path from "node:path";
import { listSessionFilesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";

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
  ensureSessionsIndexBootstrapped?: () => Promise<void>;
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
  const sessionsVisibility = cfg.sessions?.visibility ?? "current";
  const sessionsEnabled = sessionsVisibility !== "off";

  const resolveWorkspaceDir = (): string => {
    const candidate = (api as any)?.runtime?.workspaceDir;
    if (typeof candidate === "string" && candidate.trim()) {
      return path.resolve(candidate);
    }
    return path.resolve(process.cwd());
  };

  const resolveWorkspaceRelativePath = (relPath: string): string | null => {
    const trimmed = relPath.trim().replaceAll("\\", "/");
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith("/") || trimmed.includes("..")) {
      return null;
    }
    if (trimmed === "MEMORY.md") {
      return trimmed;
    }
    if (trimmed.startsWith("memory/")) {
      return trimmed;
    }
    return null;
  };

  const buildVisibleSessionFiles = async (): Promise<string[]> => {
    const currentAgentId = params.agentId;
    const agentIds = await listKnownAgentIds();
    const orderedAgentIds = [currentAgentId, ...agentIds.filter((agentId) => agentId !== currentAgentId)];
    const out: string[] = [];
    for (const agentId of orderedAgentIds) {
      const files = await listSessionFilesForAgent(agentId);
      out.push(...files);
    }
    return out;
  };

  return {
    async search(query, opts) {
      const q = query.trim();
      if (!q) {
        return [];
      }
      await params.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        agentId: params.agentId,
        sessionKey: opts?.sessionKey ?? (api as any)?.runtime?.sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      const limits = resolveMemoryLimits(cfg);

      const requestedSources =
        Array.isArray(opts?.sources) && opts.sources.length > 0 ? opts.sources : ["memory", "sessions"];
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
          await params.ensureSessionsIndexBootstrapped();
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
        const filteredSessionHits =
          sessionsVisibility === "visible"
            ? await filterSessionHitsByVisibility({ api, hits: mappedSessionHits })
            : mappedSessionHits;
        results.push(...filteredSessionHits);
      }

      // No semantic/vector layer yet.
      if (typeof opts?.onDebug === "function") {
        opts.onDebug({ backend: "builtin", configuredMode: "postgres", effectiveMode: "postgres" });
      }

      // Filter by minScore if provided (mostly relevant for vector search; keep behavior consistent).
      const minScore = typeof opts?.minScore === "number" && Number.isFinite(opts.minScore) ? opts.minScore : undefined;
      const filtered = minScore !== undefined ? results.filter((item) => item.score >= minScore) : results;
      return filtered.slice().sort(stableScoreSort).slice(0, maxResults);
    },

    async readFile(readParams) {
      await params.ensureReady();
      const relPath = readParams.relPath.trim();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        agentId: params.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      const limits = resolveMemoryLimits(cfg);
      const fromLine = readParams.from ?? 1;
      const lineCount = readParams.lines ?? limits.getDefaultLines;

      if (relPath.startsWith("sessions/")) {
        if (!sessionsEnabled) {
          return { text: "", path: readParams.relPath };
        }
        if (sessionsVisibility === "visible") {
          const verdict = await canAccessSessionPathByVisibility({
            api,
            path: relPath,
          });
          if (!verdict.allowed) {
            return { text: "", path: readParams.relPath };
          }
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

      const workspaceRelative = resolveWorkspaceRelativePath(relPath);
      if (workspaceRelative) {
        const workspaceDir = resolveWorkspaceDir();
        const absPath = path.resolve(workspaceDir, workspaceRelative);
        const relative = path.relative(workspaceDir, absPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return { text: "", path: relPath };
        }
        try {
          const content = await fs.readFile(absPath, "utf8");
          const read = buildMemoryReadResult({
            content,
            relPath: workspaceRelative,
            from: fromLine,
            lines: lineCount,
            defaultLines: limits.getDefaultLines,
            maxChars: limits.getMaxChars,
          });
          return {
            text: read.text,
            path: read.path,
            ...(read.truncated ? { truncated: true } : {}),
            ...(typeof read.from === "number" ? { from: read.from } : {}),
            ...(typeof read.lines === "number" ? { lines: read.lines } : {}),
            ...(typeof read.nextFrom === "number" ? { nextFrom: read.nextFrom } : {}),
          };
        } catch {
          return { text: "", path: relPath };
        }
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
      return {
        backend: "builtin",
        provider: "anchorclaw-postgres",
        workspaceDir,
        sources: sessionsEnabled ? ["memory", "sessions"] : ["memory"],
        custom: {
          backend: "postgres",
          postgresHost: cfg.postgres.host,
          postgresDatabase: cfg.postgres.database,
          limits,
          sessionsMaxFileBytes: limits.sessionsMaxFileBytes,
          sessionsVisibility,
          purpose: params.purpose ?? "default",
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
      await params.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: params.getPool(),
        agentId: params.agentId,
        sessionKey: (api as any)?.runtime?.sessionKey,
        configuredExternalId: cfg.identity?.externalId,
      });
      if (typeof syncParams?.progress === "function") {
        syncParams.progress({ completed: 0, total: 1, label: "syncing sessions index" });
      }
      const sessionFiles =
        Array.isArray(syncParams?.sessionFiles) && syncParams.sessionFiles.length > 0
          ? syncParams.sessionFiles
          : sessionsVisibility === "visible"
            ? await buildVisibleSessionFiles()
            : undefined;
      await syncSessionsIndexDb({
        pool: params.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        agentId: params.agentId,
        force: syncParams?.force === true,
        ...(sessionFiles ? { sessionFiles } : {}),
      });
      if (typeof syncParams?.progress === "function") {
        syncParams.progress({ completed: 1, total: 1, label: "done" });
      }
    },

    getCachedEmbeddingAvailability() {
      return { ok: false, cached: true, checked: true, error: "semantic layer not configured" };
    },

    async probeEmbeddingAvailability() {
      return { ok: false, checked: true, checkedAtMs: Date.now(), error: "semantic layer not configured" };
    },

    async probeVectorAvailability() {
      return false;
    },
  };
}
