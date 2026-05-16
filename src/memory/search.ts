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
  relaxedQuery?: string;
};

type MemorySearchRow = {
  id: string;
  title: string | null;
  type: string;
  content: string;
  updated_at: string;
  score: number;
};

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

function mapRowsToHits(rows: MemorySearchRow[], relaxedQuery?: string): MemorySearchHit[] {
  return rows.map((row) => {
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
      ...(relaxedQuery ? { relaxedQuery } : {}),
    };
  });
}

function deriveRelaxedQueries(query: string): string[] {
  const tokens = Array.from(
    new Set((query.toLowerCase().match(/[a-z0-9_@.-]+/g) ?? []).filter((token) => token.length >= 3)),
  );
  if (tokens.length < 2) {
    return [];
  }

  const candidates: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    candidates.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  candidates.push(...tokens);

  const normalizedOriginal = query.trim().toLowerCase();
  return Array.from(new Set(candidates)).filter((candidate) => candidate !== normalizedOriginal).slice(0, 6);
}

async function queryMemoryItems(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  query: string;
  limit: number;
}): Promise<MemorySearchHit[]> {
  const { rows } = await params.pool.query<MemorySearchRow>(
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
    [params.userId, params.workspaceId, params.query, params.limit],
  );

  return mapRowsToHits(rows);
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

  const strictHits = await queryMemoryItems({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    query: q,
    limit,
  });
  if (strictHits.length > 0) {
    return strictHits;
  }

  const relaxedQueries = deriveRelaxedQueries(q);
  if (relaxedQueries.length === 0) {
    return [];
  }

  const merged = new Map<string, MemorySearchHit>();
  for (const relaxedQuery of relaxedQueries) {
    const relaxedHits = await queryMemoryItems({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      query: relaxedQuery,
      limit,
    });
    for (const hit of relaxedHits) {
      const key = hit.id ?? hit.path;
      const previous = merged.get(key);
      const taggedHit = { ...hit, relaxedQuery };
      if (!previous || taggedHit.score > previous.score) {
        merged.set(key, taggedHit);
      }
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, limit);
}
