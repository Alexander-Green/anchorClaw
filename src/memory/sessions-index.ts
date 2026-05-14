import type { PostgresPool } from "../postgres.js";
import type { MemoryLimits } from "./limits.js";
import type { MemorySearchHit } from "./search.js";
import type { MemoryReadResult } from "./read-file-shared.js";

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

export function normalizeSessionLookupPath(lookup: string): string | null {
  const trimmed = lookup.trim().replaceAll("\\", "/");
  if (!trimmed.startsWith("sessions/")) {
    return null;
  }
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length !== 3) {
    return null;
  }
  const [root, agentId, fileName] = parts;
  if (root !== "sessions" || !agentId || !fileName) {
    return null;
  }
  if (fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) {
    return null;
  }
  return `sessions/${agentId}/${fileName}`;
}

function buildAgentPathPrefix(agentId: string): string {
  return `sessions/${agentId}/%`;
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function buildContinuationNotice(nextFrom: number | undefined): string {
  const base =
    typeof nextFrom === "number"
      ? `[More content available. Use from=${nextFrom} to continue.]`
      : "[More content available. Requested excerpt exceeded the default maxChars budget.]";
  return `\n\n${base}`;
}

function buildIndexedSessionReadResult(params: {
  chunks: Array<{ startLine: number; text: string }>;
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines: number;
  maxChars: number;
}): MemoryReadResult {
  const requestedFrom = clampPositiveInteger(params.from, 1);
  const requestedLineCount = clampPositiveInteger(params.lines, params.defaultLines);
  const requestedEndExclusive = requestedFrom + requestedLineCount;
  const maxChars = Math.max(1, Math.floor(params.maxChars));
  const sortedChunks = params.chunks
    .filter((chunk) => Number.isFinite(chunk.startLine) && chunk.startLine > 0)
    .slice()
    .sort((left, right) => left.startLine - right.startLine);

  if (sortedChunks.length === 0) {
    return {
      text: "",
      path: params.relPath,
      from: requestedFrom,
      lines: 0,
    };
  }

  const grouped = new Map<number, string[]>();
  for (const chunk of sortedChunks) {
    const rendered = chunk.text ?? "";
    const list = grouped.get(chunk.startLine) ?? [];
    list.push(rendered);
    grouped.set(chunk.startLine, list);
  }
  const sourceLines = Array.from(grouped.keys()).sort((left, right) => left - right);
  const selectedSourceLines = sourceLines.filter(
    (lineNo) => lineNo >= requestedFrom && lineNo < requestedEndExclusive,
  );
  if (selectedSourceLines.length === 0) {
    return {
      text: "",
      path: params.relPath,
      from: requestedFrom,
      lines: 0,
    };
  }
  const selectedRenderedLines = selectedSourceLines.flatMap((lineNo) => grouped.get(lineNo) ?? []);
  const moreSourceLinesRemain = sourceLines.some((lineNo) => lineNo >= requestedEndExclusive);

  let includedRenderedCount = selectedRenderedLines.length;
  let text = selectedRenderedLines.join("\n");
  while (includedRenderedCount > 1 && text.length > maxChars) {
    includedRenderedCount -= 1;
    text = selectedRenderedLines.slice(0, includedRenderedCount).join("\n");
  }

  let hardTruncatedSingleLine = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    includedRenderedCount = 1;
    hardTruncatedSingleLine = true;
  }

  let includedSourceLines = selectedSourceLines.length;
  if (includedRenderedCount < selectedRenderedLines.length) {
    let renderedSeen = 0;
    includedSourceLines = 0;
    for (const lineNo of selectedSourceLines) {
      renderedSeen += (grouped.get(lineNo) ?? []).length;
      if (renderedSeen > includedRenderedCount) {
        break;
      }
      includedSourceLines += 1;
    }
  }

  const truncated = hardTruncatedSingleLine || includedRenderedCount < selectedRenderedLines.length || moreSourceLinesRemain;
  const nextLineAfterRange = sourceLines.find((lineNo) => lineNo >= requestedEndExclusive);
  const nextLineWithinRange = selectedSourceLines[includedSourceLines];
  const nextFrom =
    !hardTruncatedSingleLine && includedSourceLines > 0
      ? nextLineWithinRange ?? nextLineAfterRange
      : undefined;

  return {
    text: truncated && text ? `${text}${buildContinuationNotice(nextFrom)}` : text,
    path: params.relPath,
    from: selectedSourceLines[0] ?? requestedFrom,
    lines: includedSourceLines,
    ...(truncated ? { truncated: true } : {}),
    ...(typeof nextFrom === "number" ? { nextFrom } : {}),
  };
}

export async function memorySearchSessionsIndexDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limits: MemoryLimits;
  query: string;
  maxResults?: number;
  currentAgentId?: string;
}): Promise<MemorySearchHit[]> {
  const q = params.query.trim();
  if (!q) {
    return [];
  }
  const limit = clampInteger(params.maxResults ?? params.limits.maxResults, 1, params.limits.maxResults);
  const scopedByAgent = typeof params.currentAgentId === "string" && params.currentAgentId.trim().length > 0;
  const result = await params.pool.query<{
    path: string;
    snippet: string;
    score: number;
    start_line: number;
    end_line: number;
    updated_at: string;
  }>(
    scopedByAgent
      ? `
    SELECT
      c.path,
      LEFT(c.text, 240) AS snippet,
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', $3)) AS score,
      c.start_line,
      c.end_line,
      f.updated_at
    FROM session_index_chunks c
    JOIN session_index_files f
      ON f.id = c.file_id
    WHERE c.user_id = $1
      AND c.workspace_id = $2
      AND c.search_vector @@ plainto_tsquery('simple', $3)
      AND c.path LIKE $5
    ORDER BY score DESC, f.updated_at DESC, c.path ASC, c.chunk_index ASC
    LIMIT $4
  `
      : `
    SELECT
      c.path,
      LEFT(c.text, 240) AS snippet,
      ts_rank_cd(c.search_vector, plainto_tsquery('simple', $3)) AS score,
      c.start_line,
      c.end_line,
      f.updated_at
    FROM session_index_chunks c
    JOIN session_index_files f
      ON f.id = c.file_id
    WHERE c.user_id = $1
      AND c.workspace_id = $2
      AND c.search_vector @@ plainto_tsquery('simple', $3)
    ORDER BY score DESC, f.updated_at DESC, c.path ASC, c.chunk_index ASC
    LIMIT $4
  `,
    scopedByAgent
      ? [params.userId, params.workspaceId, q, limit, buildAgentPathPrefix(params.currentAgentId!.trim())]
      : [params.userId, params.workspaceId, q, limit],
  );

  return result.rows.map((row: { path: string; snippet: string; score: number; start_line: number; end_line: number; updated_at: string }) => ({
    corpus: "sessions",
    path: row.path,
    kind: "session",
    score: Number.isFinite(row.score) ? row.score : 0,
    snippet: row.snippet.length === 240 ? `${row.snippet}…` : row.snippet,
    startLine: row.start_line,
    endLine: row.end_line,
    updatedAt: row.updated_at,
  }));
}

export async function hasSessionsIndexRows(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  currentAgentId?: string;
}): Promise<boolean> {
  const scopedByAgent = typeof params.currentAgentId === "string" && params.currentAgentId.trim().length > 0;
  const result = await params.pool.query<{ id: string }>(
    scopedByAgent
      ? `
    SELECT id
    FROM session_index_files
    WHERE user_id = $1
      AND workspace_id = $2
      AND path LIKE $3
    LIMIT 1
  `
      : `
    SELECT id
    FROM session_index_files
    WHERE user_id = $1
      AND workspace_id = $2
    LIMIT 1
  `,
    scopedByAgent
      ? [params.userId, params.workspaceId, buildAgentPathPrefix(params.currentAgentId!.trim())]
      : [params.userId, params.workspaceId],
  );
  return result.rows.length > 0;
}

export async function memoryGetSessionFromIndexDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  limits: MemoryLimits;
}): Promise<MemoryReadResult | null> {
  const normalizedPath = normalizeSessionLookupPath(params.lookup);
  if (!normalizedPath) {
    return null;
  }

  const fileResult = await params.pool.query<{ id: string }>(
    `
    SELECT id
    FROM session_index_files
    WHERE user_id = $1
      AND workspace_id = $2
      AND path = $3
    LIMIT 1
  `,
    [params.userId, params.workspaceId, normalizedPath],
  );
  const fileRow = fileResult.rows[0];
  if (!fileRow) {
    return null;
  }

  const chunks = await params.pool.query<{ text: string; start_line: number }>(
    `
    SELECT text, start_line
    FROM session_index_chunks
    WHERE file_id = $1
    ORDER BY chunk_index ASC
  `,
    [fileRow.id],
  );
  if (chunks.rows.length === 0) {
    return null;
  }

  return buildIndexedSessionReadResult({
    chunks: chunks.rows.map((row: { text: string; start_line: number }) => ({
      text: row.text,
      startLine: row.start_line,
    })),
    relPath: normalizedPath,
    from: params.fromLine,
    lines: params.lineCount,
    defaultLines: params.limits.getDefaultLines,
    maxChars: params.limits.getMaxChars,
  });
}
