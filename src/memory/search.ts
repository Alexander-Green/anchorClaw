import type { PostgresPool } from "../postgres.js";
import type { MemoryLimits } from "./limits.js";

export type MemorySearchParams = {
  query: string;
  maxResults?: number;
  corpus?: string;
};

export type MemorySearchHit = {
  corpus: "memory" | "sessions";
  path: string;
  title?: string;
  kind?: string;
  score: number;
  snippet: string;
  id?: string;
  startLine?: number;
  endLine?: number;
  citation?: string;
  updatedAt?: string;
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

export async function memorySearchDb(params: {
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

  const { rows } = await params.pool.query<{
    id: string;
    title: string | null;
    type: string;
    content: string;
    updated_at: string;
    score: number;
  }>(
    `
    SELECT
      id,
      title,
      type,
      content,
      updated_at,
      (
        ts_rank_cd(search_vector, plainto_tsquery('simple', $3))
        + CASE
            WHEN lower(coalesce(title, '')) = lower($3) THEN 3.0
            WHEN lower(content) = lower($3) THEN 2.5
            ELSE 0
          END
      ) AS score
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND search_vector @@ plainto_tsquery('simple', $3)
    ORDER BY score DESC, importance DESC, updated_at DESC, id ASC
    LIMIT $4
  `,
    [params.userId, params.workspaceId, q, limit],
  );

  return rows.map((row: {
    id: string;
    title: string | null;
    type: string;
    content: string;
    updated_at: string;
    score: number;
  }) => {
    const snippet = row.content.length > 240 ? `${row.content.slice(0, 240)}…` : row.content;
    return {
      corpus: "memory",
      path: `db-memory/items/${row.id}.md`,
      id: row.id,
      title: row.title ?? undefined,
      kind: row.type,
      score: Number.isFinite(row.score) ? row.score : 0,
      snippet,
      updatedAt: row.updated_at,
    };
  });
}
