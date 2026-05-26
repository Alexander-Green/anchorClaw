import type { PostgresPool } from "../postgres.js";
import type { MemoryLimits } from "./limits.js";
import { searchDailyEntriesDb } from "./daily.js";

export type MemorySearchParams = {
  query: string;
  maxResults?: number;
  corpus?: string;
};

export type MemorySearchHit = {
  corpus: "memory" | "daily" | "sessions";
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
  canonical_key?: string | null;
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
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "did",
    "do",
    "does",
    "i",
    "is",
    "me",
    "my",
    "of",
    "the",
    "to",
    "what",
    "which",
    "who",
    "как",
    "какая",
    "какие",
    "какой",
    "какое",
    "меня",
    "мне",
    "мой",
    "мои",
    "моя",
    "мое",
    "моё",
    "у",
    "что",
  ]);
  const tokens = Array.from(
    new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}_@.-]+/gu) ?? [])
        .filter((token) => token.length >= 2)
        .filter((token) => !stopWords.has(token)),
    ),
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
    WITH q AS (
      SELECT plainto_tsquery('simple', $3) AS ts_query
    )
    SELECT
      id,
      title,
      type,
      content,
      canonical_key,
      updated_at,
      (
        ts_rank_cd(to_tsvector('simple', search_text), q.ts_query)
        + CASE
            WHEN lower(coalesce(title, '')) = lower($3) THEN 3.0
            WHEN lower(content) = lower($3) THEN 2.5
            WHEN lower(coalesce(canonical_key, '')) = lower($3) THEN 2.25
            ELSE 0
          END
      ) AS score
    FROM memory_items, q
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND to_tsvector('simple', search_text) @@ q.ts_query
    ORDER BY score DESC, importance DESC, updated_at DESC, id ASC
    LIMIT $4
  `,
    [params.userId, params.workspaceId, params.query, params.limit],
  );

  return mapRowsToHits(rows);
}

async function queryMemoryItemsFuzzy(params: {
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
      canonical_key,
      updated_at,
      (
        GREATEST(
          similarity(lower(search_text), lower($3)),
          word_similarity(lower($3), lower(search_text))
        )
        + CASE
            WHEN lower(search_text) LIKE ('%' || lower($3) || '%') THEN 0.6
            WHEN lower(coalesce(canonical_key, '')) LIKE ('%' || lower($3) || '%') THEN 0.4
            ELSE 0
          END
      ) AS score
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND (
        lower(search_text) LIKE ('%' || lower($3) || '%')
        OR lower(coalesce(canonical_key, '')) LIKE ('%' || lower($3) || '%')
        OR word_similarity(lower($3), lower(search_text)) >= 0.45
        OR similarity(lower(search_text), lower($3)) >= 0.35
      )
    ORDER BY score DESC, importance DESC, updated_at DESC, id ASC
    LIMIT $4
  `,
    [params.userId, params.workspaceId, params.query, params.limit],
  );

  return mapRowsToHits(rows);
}

async function queryImportedDailyMemory(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  query: string;
  limit: number;
  relaxedQuery?: string;
}): Promise<MemorySearchHit[]> {
  return searchDailyEntriesDb(params);
}

function sortMergedHits(left: MemorySearchHit, right: MemorySearchHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const leftKind = left.kind === "daily-note" ? 1 : 0;
  const rightKind = right.kind === "daily-note" ? 1 : 0;
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return left.path.localeCompare(right.path);
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
  const strictDailyHits = await queryImportedDailyMemory({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    query: q,
    limit,
  });
  if (strictHits.length > 0 || strictDailyHits.length > 0) {
    return [...strictHits, ...strictDailyHits].sort(sortMergedHits).slice(0, limit);
  }

  const fuzzyHits = await queryMemoryItemsFuzzy({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    query: q,
    limit,
  });
  if (fuzzyHits.length > 0) {
    return fuzzyHits.slice(0, limit);
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
    const relaxedDailyHits = await queryImportedDailyMemory({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      query: relaxedQuery,
      limit,
    });
    for (const hit of relaxedDailyHits) {
      const key = hit.id ?? hit.path;
      const previous = merged.get(key);
      const taggedHit = { ...hit, relaxedQuery };
      if (!previous || taggedHit.score > previous.score) {
        merged.set(key, taggedHit);
      }
    }
  }

  return Array.from(merged.values())
    .sort(sortMergedHits)
    .slice(0, limit);
}

export async function memorySearchDailyDb(params: {
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

  const strictHits = await queryImportedDailyMemory({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    query: q,
    limit,
  });
  if (strictHits.length > 0) {
    return strictHits.slice(0, limit);
  }

  const relaxedQueries = deriveRelaxedQueries(q);
  if (relaxedQueries.length === 0) {
    return [];
  }

  const merged = new Map<string, MemorySearchHit>();
  for (const relaxedQuery of relaxedQueries) {
    const relaxedDailyHits = await queryImportedDailyMemory({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      query: relaxedQuery,
      limit,
      relaxedQuery,
    });
    for (const hit of relaxedDailyHits) {
      const key = hit.id ?? hit.path;
      const previous = merged.get(key);
      if (!previous || hit.score > previous.score) {
        merged.set(key, hit);
      }
    }
  }

  return Array.from(merged.values())
    .sort(sortMergedHits)
    .slice(0, limit);
}
