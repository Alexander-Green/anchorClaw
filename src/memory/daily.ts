import type { PostgresPool } from "../postgres.js";
import type { MemorySearchHit } from "./search.js";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

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
      blockId: string;
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
export const STARTUP_DAILY_MEMORY_DAYS = 2;
export const STARTUP_MAX_SLUGGED_FILES_PER_DAY = 4;

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

type DailyWriteClient = Pick<PoolClient, "query">;

type DailyBlockWriteParams = {
  client: DailyWriteClient;
  userId: string;
  workspaceId: string;
  logicalDate: string;
  path: string;
  content: string;
  sourceKind: string;
  sourcePath?: string | null;
  metadata?: Record<string, unknown>;
  actor?: string;
  conflictPolicy?: "append" | "reject";
  auditOperationInsert?: string;
  auditOperationUpdate?: string;
};

export async function appendDailyBlockTx(
  params: DailyBlockWriteParams,
): Promise<Extract<MemoryLogResult, { ok: true }>> {
  if (!params.content.trim()) {
    throw new Error("content is required");
  }

  const contentSha256 = sha256Hex(params.content);
  const insertedEntry = await params.client.query<{
    id: string;
    content: string;
    content_sha256: string;
    source_kind: string;
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
    VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9::jsonb, $10)
    ON CONFLICT (user_id, workspace_id, path) DO NOTHING
    RETURNING id, content, content_sha256, source_kind, updated_at
    `,
    [
      params.userId,
      params.workspaceId,
      params.logicalDate,
      params.path,
      params.content,
      contentSha256,
      params.sourceKind,
      params.sourcePath ?? null,
      JSON.stringify(params.metadata ?? {}),
      params.actor ?? "anchorclaw",
    ],
  );

  let entry = insertedEntry.rows[0] ?? null;
  const created = Boolean(entry);
  if (!entry) {
    if ((params.conflictPolicy ?? "append") === "reject") {
      throw new Error(`daily path already exists: ${params.path}`);
    }
    const locked = await params.client.query<{
      id: string;
      content: string;
      content_sha256: string;
      source_kind: string;
      updated_at: string;
    }>(
      `
      SELECT id, content, content_sha256, source_kind, updated_at
      FROM memory_daily_entries
      WHERE user_id = $1
        AND workspace_id = $2
        AND path = $3
      FOR UPDATE
      `,
      [params.userId, params.workspaceId, params.path],
    );
    entry = locked.rows[0] ?? null;
    if (!entry) {
      throw new Error(`daily path disappeared during append: ${params.path}`);
    }
  }

  const blockIndexResult = await params.client.query<{ block_index: string | number }>(
    `
    SELECT coalesce(max(block_index), -1) + 1 AS block_index
    FROM memory_daily_blocks
    WHERE daily_entry_id = $1
    `,
    [entry.id],
  );
  const blockIndex = Number(blockIndexResult.rows[0]?.block_index ?? 0);
  const insertedBlock = await params.client.query<{ id: string }>(
    `
    INSERT INTO memory_daily_blocks (
      user_id,
      workspace_id,
      daily_entry_id,
      block_index,
      logical_date,
      daily_path,
      content,
      content_sha256,
      source_kind,
      source_path,
      metadata,
      created_by
    )
    VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11::jsonb, $12)
    RETURNING id
    `,
    [
      params.userId,
      params.workspaceId,
      entry.id,
      blockIndex,
      params.logicalDate,
      params.path,
      params.content,
      contentSha256,
      params.sourceKind,
      params.sourcePath ?? null,
      JSON.stringify(params.metadata ?? {}),
      params.actor ?? "anchorclaw",
    ],
  );
  const blockId = insertedBlock.rows[0]?.id;
  if (!blockId) {
    throw new Error("failed to append daily memory block");
  }

  let updatedAt = entry.updated_at;
  let nextContent = entry.content;
  let nextContentSha256 = entry.content_sha256;
  let projectionSourceKind = entry.source_kind;
  if (!created) {
    nextContent = `${entry.content.replace(/\s*$/u, "")}\n\n${params.content}`;
    nextContentSha256 = sha256Hex(nextContent);
    projectionSourceKind =
      entry.source_kind === params.sourceKind ? params.sourceKind : "mixed";
    const updated = await params.client.query<{ updated_at: string }>(
      `
      UPDATE memory_daily_entries
      SET
        logical_date = $2::date,
        content = $3,
        content_sha256 = $4,
        source_kind = $5,
        source_path = $6,
        metadata = $7::jsonb,
        updated_at = now()
      WHERE id = $1
      RETURNING updated_at
      `,
      [
        entry.id,
        params.logicalDate,
        nextContent,
        nextContentSha256,
        projectionSourceKind,
        projectionSourceKind === "mixed" ? null : params.sourcePath ?? null,
        JSON.stringify({
          projection: true,
          lastBlockId: blockId,
          lastBlockIndex: blockIndex,
          lastSourceKind: params.sourceKind,
          lastSourcePath: params.sourcePath ?? null,
        }),
      ],
    );
    updatedAt = updated.rows[0]?.updated_at ?? updatedAt;
  }

  await params.client.query(
    `
    INSERT INTO memory_audit_log (user_id, operation, before, after, actor, created_at)
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
    `,
    [
      params.userId,
      created
        ? params.auditOperationInsert ?? "daily_block_insert"
        : params.auditOperationUpdate ?? "daily_block_append",
      created
        ? null
        : JSON.stringify({
            id: entry.id,
            content_sha256: entry.content_sha256,
            source_kind: entry.source_kind,
            updated_at: entry.updated_at,
          }),
      JSON.stringify({
        id: entry.id,
        block_id: blockId,
        block_index: blockIndex,
        path: params.path,
        logical_date: params.logicalDate,
        source_kind: projectionSourceKind,
        appended_source_kind: params.sourceKind,
        source_path: params.sourcePath ?? null,
        content_sha256: nextContentSha256,
      }),
      params.actor ?? "anchorclaw",
    ],
  );

  return {
    ok: true,
    corpus: "daily",
    id: entry.id,
    blockId,
    path: params.path,
    logicalDate: params.logicalDate,
    updatedAt,
    created,
  };
}

export async function appendDailyBlockDb(
  params: Omit<DailyBlockWriteParams, "client"> & {
    pool: PostgresPool;
    logger?: { warn(message: string): void };
  },
): Promise<MemoryLogResult> {
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await appendDailyBlockTx({ ...params, client });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      params.logger?.warn(
        `anchorclaw: daily block rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
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

function shiftDateStampByCalendarDays(stamp: string, offsetDays: number): string {
  const [yearRaw, monthRaw, dayRaw] = stamp.split("-").map((part) => Number.parseInt(part, 10));
  if (!yearRaw || !monthRaw || !dayRaw) {
    return stamp;
  }
  const shifted = new Date(Date.UTC(yearRaw, monthRaw - 1, dayRaw - offsetDays));
  return shifted.toISOString().slice(0, 10);
}

export function buildStartupMemoryDateStamps(params: {
  nowMs?: number;
  timezone?: string;
  dailyMemoryDays?: number;
}): string[] {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const dailyMemoryDays = Math.max(1, Math.trunc(params.dailyMemoryDays ?? STARTUP_DAILY_MEMORY_DAYS));
  const localTodayStamp = formatDateInTimezone(nowMs, params.timezone);
  const utcTodayStamp = formatDateInTimezone(nowMs, "UTC");
  const localWindow: string[] = [];

  for (let offset = 0; offset < dailyMemoryDays; offset += 1) {
    localWindow.push(shiftDateStampByCalendarDays(localTodayStamp, offset));
  }

  if (utcTodayStamp === localTodayStamp || localWindow.includes(utcTodayStamp)) {
    return localWindow;
  }

  return utcTodayStamp > localTodayStamp
    ? [utcTodayStamp, ...localWindow]
    : [...localWindow, utcTodayStamp];
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
  logicalDates: string[];
  maxSluggedPerDay?: number;
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
  const logicalDates = Array.from(
    new Set(params.logicalDates.filter((value) => /^\d{4}-\d{2}-\d{2}$/u.test(value))),
  );
  if (logicalDates.length === 0) {
    return [];
  }

  const result = await params.pool.query<{
    id: string;
    path: string;
    logical_date: string;
    content: string;
    source_kind: string;
    created_at: string;
    updated_at: string;
    day_ordinal: number;
    path_kind: number;
  }>(
    `
    WITH requested_days AS (
      SELECT logical_date, ordinality AS day_ordinal
      FROM unnest($3::text[]) WITH ORDINALITY AS requested(logical_date, ordinality)
    ),
    ranked AS (
      SELECT
        entry.id,
        entry.path,
        entry.logical_date::text AS logical_date,
        entry.content,
        entry.source_kind,
        entry.created_at,
        entry.updated_at,
        requested.day_ordinal,
        CASE
          WHEN entry.path = ('memory/' || requested.logical_date || '.md') THEN 0
          ELSE 1
        END AS path_kind,
        ROW_NUMBER() OVER (
          PARTITION BY requested.logical_date,
          CASE
            WHEN entry.path = ('memory/' || requested.logical_date || '.md') THEN 0
            ELSE 1
          END
          ORDER BY entry.updated_at DESC, entry.path DESC, entry.id DESC
        ) AS ordinal_in_kind
      FROM requested_days requested
      JOIN memory_daily_entries entry
        ON entry.user_id = $1
       AND entry.workspace_id = $2
       AND entry.logical_date::text = requested.logical_date
       AND (
         entry.path = ('memory/' || requested.logical_date || '.md')
         OR entry.path LIKE ('memory/' || requested.logical_date || '-%.md')
       )
    )
    SELECT
      id,
      path,
      logical_date,
      content,
      source_kind,
      created_at,
      updated_at,
      day_ordinal,
      path_kind
    FROM ranked
    WHERE path_kind = 0
       OR (path_kind = 1 AND ordinal_in_kind <= $4)
    ORDER BY day_ordinal ASC, path_kind ASC, updated_at DESC, path DESC, id DESC
  `,
    [
      params.userId,
      params.workspaceId,
      logicalDates,
      Math.max(0, Math.trunc(params.maxSluggedPerDay ?? STARTUP_MAX_SLUGGED_FILES_PER_DAY)),
    ],
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
  return appendDailyBlockDb({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    logicalDate: params.logicalDate,
    path,
    content: trimmed,
    sourceKind: params.sourceKind ?? "memory_log",
    sourcePath: params.sourcePath,
    metadata: params.metadata,
    actor: params.actor,
    logger: params.logger,
    auditOperationInsert: "daily_append_insert",
    auditOperationUpdate: "daily_append_update",
  });
}
