import type { PostgresPool } from "../postgres.js";
import type { MemorySearchHit } from "./search.js";
import { createHash } from "node:crypto";

export type MemoryDailyEntry = {
  id: string;
  path: string;
  logicalDate: string;
  content: string;
  contentSha256: string;
  sourceKind: string;
  sourcePath: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type MemoryLogResult =
  | {
      ok: true;
      corpus: "daily";
      id: string;
      path: string;
      logicalDate: string;
      updatedAt: string;
      created: boolean;
    }
  | {
      ok: false;
      error: string;
    };

type DailyEntryRow = {
  id: string;
  path: string;
  logical_date: string;
  content: string;
  content_sha256: string;
  source_kind: string;
  source_path: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type DailySearchRow = {
  id: string;
  path: string;
  content: string;
  source_kind: string;
  updated_at: string;
  score: number;
};

export const INTERNAL_ONLY_DAILY_SOURCE_KINDS = ["session_memory"] as const;

export function isInternalOnlyDailySourceKind(sourceKind: string | null | undefined): boolean {
  return INTERNAL_ONLY_DAILY_SOURCE_KINDS.includes(sourceKind as (typeof INTERNAL_ONLY_DAILY_SOURCE_KINDS)[number]);
}

function mapDailyEntryRow(row: DailyEntryRow): MemoryDailyEntry {
  return {
    id: row.id,
    path: row.path,
    logicalDate: row.logical_date,
    content: row.content,
    contentSha256: row.content_sha256,
    sourceKind: row.source_kind,
    sourcePath: row.source_path,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatDateInTimezone(nowMs: number, timezone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    ...(timezone ? { timeZone: timezone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  const local = new Date(nowMs);
  const yyyy = String(local.getFullYear());
  const mm = String(local.getMonth() + 1).padStart(2, "0");
  const dd = String(local.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveDailyLogicalDate(params: {
  nowMs?: number;
  timezone?: string;
  explicitDate?: string;
} = {}): string {
  if (typeof params.explicitDate === "string" && params.explicitDate.trim()) {
    const trimmed = params.explicitDate.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
      throw new Error("date must use YYYY-MM-DD");
    }
    return trimmed;
  }
  return formatDateInTimezone(
    Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now(),
    params.timezone,
  );
}

export function parseLogicalDateFromDailyPath(pathValue: string): string | null {
  const match = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(pathValue.trim());
  return match?.[1] ?? null;
}

export async function getDailyEntryByPath(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  path: string;
}): Promise<MemoryDailyEntry | null> {
  const result = await params.pool.query<DailyEntryRow>(
    `
    SELECT
      id,
      path,
      logical_date::text AS logical_date,
      content,
      content_sha256,
      source_kind,
      source_path,
      metadata,
      created_at,
      updated_at
    FROM memory_daily_entries
    WHERE user_id = $1
      AND workspace_id = $2
      AND path = $3
    LIMIT 1
  `,
    [params.userId, params.workspaceId, params.path],
  );
  return result.rows[0] ? mapDailyEntryRow(result.rows[0]) : null;
}

export async function getDailyEntryById(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  id: string;
}): Promise<MemoryDailyEntry | null> {
  const result = await params.pool.query<DailyEntryRow>(
    `
    SELECT
      id,
      path,
      logical_date::text AS logical_date,
      content,
      content_sha256,
      source_kind,
      source_path,
      metadata,
      created_at,
      updated_at
    FROM memory_daily_entries
    WHERE user_id = $1
      AND workspace_id = $2
      AND id = $3
    LIMIT 1
  `,
    [params.userId, params.workspaceId, params.id],
  );
  return result.rows[0] ? mapDailyEntryRow(result.rows[0]) : null;
}

export async function queryPromptDailyEntries(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limit: number;
}): Promise<
  Array<{
    id: string;
    path: string;
    logicalDate: string;
    content: string;
    sourceKind: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  const result = await params.pool.query<{
    id: string;
    path: string;
    logical_date: string;
    content: string;
    source_kind: string;
    created_at: string;
    updated_at: string;
  }>(
    `
    SELECT
      id,
      path,
      logical_date::text AS logical_date,
      content,
      source_kind,
      created_at,
      updated_at
    FROM memory_daily_entries
    WHERE user_id = $1
      AND workspace_id = $2
    ORDER BY logical_date DESC, updated_at DESC, path ASC, id ASC
    LIMIT $3
  `,
    [params.userId, params.workspaceId, params.limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    path: row.path,
    logicalDate: row.logical_date,
    content: row.content,
    sourceKind: row.source_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function searchDailyEntriesDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  query: string;
  limit: number;
  relaxedQuery?: string;
}): Promise<MemorySearchHit[]> {
  const { rows } = await params.pool.query<DailySearchRow>(
    `
    SELECT
      id,
      path,
      content,
      source_kind,
      updated_at,
      (
        ts_rank_cd(to_tsvector('simple', content), plainto_tsquery('simple', $3))
        + CASE
            WHEN lower(content) = lower($3) THEN 2.5
            ELSE 0
          END
      ) AS score
    FROM memory_daily_entries
    WHERE user_id = $1
      AND workspace_id = $2
      AND source_kind <> ALL($5::text[])
      AND to_tsvector('simple', content) @@ plainto_tsquery('simple', $3)
    ORDER BY score DESC, logical_date DESC, updated_at DESC, id ASC
    LIMIT $4
  `,
    [
      params.userId,
      params.workspaceId,
      params.query,
      params.limit,
      [...INTERNAL_ONLY_DAILY_SOURCE_KINDS],
    ],
  );

  return rows.map((row) => {
    const snippet = row.content.length > 240 ? `${row.content.slice(0, 240)}…` : row.content;
    return {
      corpus: "daily",
      path: row.path,
      id: row.id,
      title: row.path,
      kind: row.source_kind === "session_memory" ? "session-capture" : "daily-note",
      sourceKind: row.source_kind,
      score: Number.isFinite(row.score) ? row.score : 0,
      snippet,
      updatedAt: row.updated_at,
      ...(params.relaxedQuery ? { relaxedQuery: params.relaxedQuery } : {}),
    } satisfies MemorySearchHit;
  });
}

export async function appendDailyEntryDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  actor?: string;
  logger?: { warn(message: string): void };
  logicalDate: string;
  content: string;
  sourceKind?: string;
  sourcePath?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<MemoryLogResult> {
  const trimmed = params.content.trim();
  if (!trimmed) {
    return { ok: false, error: "content is required" };
  }

  const path = `memory/${params.logicalDate}.md`;
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{
      id: string;
      content: string;
      updated_at: string;
    }>(
      `
      SELECT id, content, updated_at
      FROM memory_daily_entries
      WHERE user_id = $1
        AND workspace_id = $2
        AND path = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, path],
    );

    const before = existing.rows[0] ?? null;
    const nextContent = before
      ? `${before.content.replace(/\s*$/u, "")}\n\n${trimmed}`
      : trimmed;
    const nextSha = sha256Hex(nextContent);
    const rowResult = await client.query<{
      id: string;
      updated_at: string;
    }>(
      `
      INSERT INTO memory_daily_entries (
        user_id,
        workspace_id,
        logical_date,
        path,
        content,
        content_sha256,
        source_kind,
        source_path,
        metadata,
        created_by
      )
      VALUES (
        $1,
        $2,
        $3::date,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10
      )
      ON CONFLICT (user_id, workspace_id, path)
      DO UPDATE SET
        logical_date = EXCLUDED.logical_date,
        content = EXCLUDED.content,
        content_sha256 = EXCLUDED.content_sha256,
        source_kind = EXCLUDED.source_kind,
        source_path = EXCLUDED.source_path,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id, updated_at
    `,
      [
        params.userId,
        params.workspaceId,
        params.logicalDate,
        path,
        nextContent,
        nextSha,
        params.sourceKind ?? "memory_log",
        params.sourcePath ?? null,
        JSON.stringify(params.metadata ?? {}),
        params.actor ?? "anchorclaw",
      ],
    );

    const row = rowResult.rows[0];
    if (!row) {
      throw new Error("failed to append daily memory entry");
    }

    await client.query(
      `
      INSERT INTO memory_audit_log (user_id, operation, before, after, actor, created_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
    `,
      [
        params.userId,
        before ? "daily_append_update" : "daily_append_insert",
        before ? JSON.stringify(before) : null,
        JSON.stringify({
          id: row.id,
          path,
          logical_date: params.logicalDate,
          source_kind: params.sourceKind ?? "memory_log",
          source_path: params.sourcePath ?? null,
          metadata: params.metadata ?? {},
          content_sha256: nextSha,
        }),
        params.actor ?? "anchorclaw",
      ],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      corpus: "daily",
      id: row.id,
      path,
      logicalDate: params.logicalDate,
      updatedAt: row.updated_at,
      created: !before,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      params.logger?.warn(
        `anchorclaw: memory_log rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}
