import type { PostgresPool } from "../postgres.js";
import type { MemoryLimits } from "./limits.js";
import { memorySearchDb, type MemorySearchHit } from "./search.js";

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

export type MemoryRecallResult =
  | {
      ok: true;
      corpus: "memory";
      retrievalMode: "fts" | "importance_recent";
      results: MemorySearchHit[];
      count: number;
    }
  | {
      ok: false;
      disabled?: boolean;
      error: string;
    };

export async function memoryRecallDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limits: MemoryLimits;
  input: unknown;
}): Promise<MemoryRecallResult> {
  const raw = (params.input ?? {}) as any;
  const query = typeof raw?.query === "string" ? raw.query : "";
  const maxResults =
    typeof raw?.maxResults === "number" ? raw.maxResults : undefined;

  const q = query.trim();
  const limit = clampInteger(maxResults ?? params.limits.maxResults, 1, params.limits.maxResults);

  // Recall is a shortcut: if a query is provided, behave like search; otherwise return the most important recent items.
  if (q) {
    const hits = await memorySearchDb({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      limits: params.limits,
      query: q,
      ...(typeof maxResults === "number" ? { maxResults } : {}),
    });
    return { ok: true, corpus: "memory", retrievalMode: "fts", results: hits, count: hits.length };
  }

  type RecallRow = {
    id: string;
    title: string | null;
    type: string;
    content: string;
    updated_at: string;
    score: number;
  };

  const result = await params.pool.query<RecallRow>(
    `
    SELECT
      id,
      title,
      type,
      content,
      updated_at,
      0::float AS score
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
    ORDER BY importance DESC, updated_at DESC, id ASC
    LIMIT $3
  `,
    [params.userId, params.workspaceId, limit],
  );
  const rows = result.rows as RecallRow[];

  const results: MemorySearchHit[] = rows.map((row: RecallRow) => {
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

  return { ok: true, corpus: "memory", retrievalMode: "importance_recent", results, count: results.length };
}
