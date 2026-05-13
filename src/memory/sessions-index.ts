import type { PostgresPool } from "../postgres.js";
import type { MemoryLimits } from "./limits.js";
import type { MemorySearchHit } from "./search.js";
import { buildMemoryReadResult, type MemoryReadResult } from "./read-file-shared.js";

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

export async function memorySearchSessionsIndexDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limits: MemoryLimits;
  query: string;
  maxResults?: number;
}): Promise<MemorySearchHit[]> {
  const q = params.query.trim();
  if (!q) {
    return [];
  }
  const limit = clampInteger(params.maxResults ?? params.limits.maxResults, 1, params.limits.maxResults);
  const result = await params.pool.query<{
    path: string;
    snippet: string;
    score: number;
    start_line: number;
    end_line: number;
    updated_at: string;
  }>(
    `
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
    [params.userId, params.workspaceId, q, limit],
  );

  return result.rows.map((row) => ({
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

  const chunks = await params.pool.query<{ text: string }>(
    `
    SELECT text
    FROM session_index_chunks
    WHERE file_id = $1
    ORDER BY chunk_index ASC
  `,
    [fileRow.id],
  );
  if (chunks.rows.length === 0) {
    return null;
  }

  const content = chunks.rows.map((row) => row.text).join("\n");
  return buildMemoryReadResult({
    content,
    relPath: normalizedPath,
    from: params.fromLine,
    lines: params.lineCount,
    defaultLines: params.limits.getDefaultLines,
    maxChars: params.limits.getMaxChars,
  });
}
