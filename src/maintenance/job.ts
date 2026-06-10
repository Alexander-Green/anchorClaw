import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { memoryStoreDb } from "../memory/store.js";
import type { PostgresPool } from "../postgres.js";
import { extractMaintenanceCandidates } from "./extractor.js";

const SOURCE_KIND = "daily_entries";
const EXTRACTOR_ALLOWED_DAILY_SOURCE_KINDS = ["memory_log"] as const;
const EXTRACTOR_MIN_CONFIDENCE = 80;
const DAILY_BLOCK_PIPELINE_VERSION = 1;
const DAILY_BLOCK_WINDOW_CHARS = 768;
const DAILY_BLOCK_WINDOW_OVERLAP_CHARS = 128;

type ExistingContentRow = { content: string };

type DailyBlockRow = {
  id: string;
  block_index: string | number;
  daily_path: string;
  logical_date: string;
  content: string;
  source_kind: string;
};

type ProcessedBlockWindowRow = {
  daily_block_id: string;
  pipeline_version: number;
  window_index: number;
};

type DailyWindow = {
  blockId: string;
  blockIndex: number;
  path: string;
  logicalDate: string;
  pipelineVersion: number;
  windowIndex: number;
  windowSha256: string;
  charStart: number;
  charEnd: number;
  content: string;
};

type PreparedTranscript = {
  transcript: string;
  sourcePath: string;
  fileHash: string;
  includedWindows: DailyWindow[];
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeComparableContent(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

async function candidateAlreadyExists(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  type: "fact" | "note";
  content: string;
  canonicalKey?: string;
}): Promise<boolean> {
  if (params.canonicalKey) {
    const canonical = await params.pool.query<{ one: number }>(
      `
      SELECT 1 AS one
      FROM memory_items
      WHERE user_id = $1
        AND workspace_id = $2
        AND status = 'active'
        AND type = $3
        AND canonical_key = $4
      LIMIT 1
      `,
      [params.userId, params.workspaceId, params.type, params.canonicalKey],
    );
    if ((canonical.rowCount ?? 0) > 0) {
      return true;
    }
  }

  const normalized = normalizeComparableContent(params.content);
  if (!normalized) {
    return true;
  }

  const exact = await params.pool.query<{ one: number }>(
    `
      SELECT 1 AS one
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND lower(regexp_replace(content, '\\s+', ' ', 'g')) = $3
    LIMIT 1
    `,
    [params.userId, params.workspaceId, normalized],
  );
  if ((exact.rowCount ?? 0) > 0) {
    return true;
  }

  const lexical = await params.pool.query<ExistingContentRow>(
    `
    SELECT content
    FROM memory_items
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'active'
      AND search_vector @@ websearch_to_tsquery('simple', $3)
    ORDER BY ts_rank(search_vector, websearch_to_tsquery('simple', $3)) DESC
    LIMIT 3
    `,
    [params.userId, params.workspaceId, params.content],
  );
  for (const row of lexical.rows) {
    const existing = normalizeComparableContent(row.content);
    if (!existing) {
      continue;
    }
    if (existing.includes(normalized) || normalized.includes(existing)) {
      return true;
    }
  }

  return false;
}

function isDurableCandidate(text: string): boolean {
  const body = text.trim();
  if (body.length < 48) {
    return false;
  }
  const normalized = body.toLowerCase();
  const signals = [
    "remember",
    "preference",
    "prefer",
    "always",
    "never",
    "rule",
    "policy",
    "decision",
    "decide",
    "todo",
    "must",
  ];
  return signals.some((token) => normalized.includes(token));
}

function splitDailyBlockIntoWindows(row: DailyBlockRow): DailyWindow[] {
  const normalized = row.content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const windows: DailyWindow[] = [];
  const stride = DAILY_BLOCK_WINDOW_CHARS - DAILY_BLOCK_WINDOW_OVERLAP_CHARS;
  for (let offset = 0; offset < normalized.length; offset += stride) {
    const content = normalized.slice(offset, offset + DAILY_BLOCK_WINDOW_CHARS);
    windows.push({
      blockId: row.id,
      blockIndex: Number(row.block_index),
      path: row.daily_path,
      logicalDate: row.logical_date,
      pipelineVersion: DAILY_BLOCK_PIPELINE_VERSION,
      windowIndex: Math.floor(offset / stride),
      windowSha256: sha256Hex(content),
      charStart: offset,
      charEnd: offset + content.length,
      content,
    });
  }
  return windows;
}

function renderDailyWindow(window: DailyWindow): string {
  return [
    `Source: ${window.path}`,
    `Logical-Date: ${window.logicalDate}`,
    `Block: ${window.blockIndex + 1}`,
    `Window: ${window.windowIndex + 1}`,
    `Pipeline-Version: ${window.pipelineVersion}`,
    `Chars: ${window.charStart}-${window.charEnd}`,
    "",
    window.content,
  ].join("\n");
}

function buildSourcePath(windows: DailyWindow[]): string {
  const first = windows[0];
  const last = windows[windows.length - 1];
  if (!first || !last) {
    return "daily";
  }
  if (
    first.path === last.path &&
    first.blockIndex === last.blockIndex &&
    first.windowIndex === last.windowIndex
  ) {
    return `${first.path}#block=${first.blockIndex + 1}&window=${first.windowIndex + 1}`;
  }
  return `${first.path}#block=${first.blockIndex + 1}&window=${first.windowIndex + 1}..${last.path}#block=${last.blockIndex + 1}&window=${last.windowIndex + 1}`;
}

function prepareTranscript(windows: DailyWindow[], maxChars: number): PreparedTranscript {
  const safeMaxChars = Math.max(1, maxChars);
  const chunks: string[] = [];
  const includedWindows: DailyWindow[] = [];
  let length = 0;

  for (const window of windows) {
    const chunk = renderDailyWindow(window);
    const addition = chunks.length === 0 ? chunk.length : chunk.length + 2;
    if (length + addition > safeMaxChars) {
      break;
    }
    chunks.push(chunk);
    includedWindows.push(window);
    length += addition;
  }

  if (includedWindows.length === 0 && windows.length > 0) {
    throw new Error(
      `maintenance transcript window too small for a single daily window (maxCharsPerRun=${safeMaxChars})`,
    );
  }

  const transcript = chunks.join("\n\n");
  return {
    transcript,
    sourcePath: buildSourcePath(includedWindows),
    fileHash: sha256Hex(transcript),
    includedWindows,
  };
}

function buildProcessedWindowKey(window: DailyWindow): string {
  return `${window.blockId}:${window.pipelineVersion}:${window.windowIndex}`;
}

function selectPendingWindowsForRun(params: {
  allWindows: DailyWindow[];
  processedKeys: Set<string>;
  batchSize: number;
}): DailyWindow[] {
  const pendingWindows = params.allWindows.filter(
    (window) => !params.processedKeys.has(buildProcessedWindowKey(window)),
  );
  if (pendingWindows.length === 0) {
    return [];
  }

  const firstDailyPath = pendingWindows[0]?.path;
  if (!firstDailyPath) {
    return [];
  }

  return pendingWindows
    .filter((window) => window.path === firstDailyPath)
    .slice(0, Math.max(1, params.batchSize));
}

async function selectPendingWindowsPage(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  batchSize: number;
}): Promise<DailyWindow[]> {
  const pageSize = Math.max(1, params.batchSize);

  for (let offset = 0; ; offset += pageSize) {
    const blockRows = await params.pool.query<DailyBlockRow>(
      `
      SELECT
        id,
        block_index,
        daily_path,
        logical_date::text AS logical_date,
        content,
        source_kind
      FROM memory_daily_blocks
      WHERE user_id = $1
        AND workspace_id = $2
        AND source_kind = ANY($3::text[])
      ORDER BY logical_date ASC, daily_path ASC, block_index ASC, id ASC
      LIMIT $4
      OFFSET $5
      `,
      [
        params.userId,
        params.workspaceId,
        EXTRACTOR_ALLOWED_DAILY_SOURCE_KINDS,
        pageSize,
        offset,
      ],
    );

    if ((blockRows.rowCount ?? 0) === 0) {
      return [];
    }

    const allWindows = blockRows.rows.flatMap((row) => splitDailyBlockIntoWindows(row));
    const blockIds = Array.from(new Set(allWindows.map((window) => window.blockId)));
    const processedRows =
      blockIds.length > 0
        ? await params.pool.query<ProcessedBlockWindowRow>(
            `
            SELECT daily_block_id, pipeline_version, window_index
            FROM memory_daily_block_extraction_windows
            WHERE user_id = $1
              AND workspace_id = $2
              AND daily_block_id = ANY($3::uuid[])
            `,
            [params.userId, params.workspaceId, blockIds],
          )
        : { rows: [], rowCount: 0 };

    const processedKeys = new Set(
      processedRows.rows.map(
        (row) => `${row.daily_block_id}:${row.pipeline_version}:${row.window_index}`,
      ),
    );

    const pendingWindows = selectPendingWindowsForRun({
      allWindows,
      processedKeys,
      batchSize: params.batchSize,
    });
    if (pendingWindows.length > 0) {
      return pendingWindows;
    }

    if ((blockRows.rowCount ?? 0) < pageSize) {
      return [];
    }
  }
}

export type MaintenanceCycleResult = {
  status: "completed" | "failed";
  runId: string | null;
  scannedCount: number;
  heuristicCandidateCount: number;
  insertedCount: number;
  skippedCount: number;
  dryRun: boolean;
  error?: string;
};

export async function runMaintenanceCycle(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
  dryRun: boolean;
  batchSize: number;
}): Promise<MaintenanceCycleResult> {
  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool: params.pool,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    configuredExternalId: params.cfg.identity?.externalId,
  });

  let runId: string | null = null;
  let scannedCount = 0;
  let heuristicCandidateCount = 0;
  let insertedCount = 0;
  let skippedCount = 0;

  try {
    const runInsert = await params.pool.query<{ id: string }>(
      `
      INSERT INTO memory_maintenance_runs (
        user_id, workspace_id, source_kind, status, dry_run
      )
      VALUES ($1, $2, $3, 'running', $4)
      RETURNING id
      `,
      [scope.userId, scope.workspaceId, SOURCE_KIND, params.dryRun],
    );
    runId = runInsert.rows[0]?.id ?? null;

    const maxChars = params.cfg.maintenance?.extractor?.maxCharsPerRun ?? 12_000;
    const pendingWindows = await selectPendingWindowsPage({
      pool: params.pool,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      batchSize: params.batchSize,
    });
    const preparedTranscript = prepareTranscript(pendingWindows, maxChars);
    const transcript = preparedTranscript.transcript;
    const processedWindows = preparedTranscript.includedWindows;

    scannedCount = processedWindows.length;
    heuristicCandidateCount = processedWindows.filter((window) => isDurableCandidate(window.content)).length;

    if (!params.dryRun && processedWindows.length > 0) {
      const extractorCfg = params.cfg.maintenance?.extractor;
      if (!extractorCfg?.enabled) {
        skippedCount += heuristicCandidateCount;
        params.api.logger.warn(
          "anchorclaw: maintenance extractor is disabled; non-dry-run promotion skipped",
        );
      } else {
        const extracted = await extractMaintenanceCandidates({
          api: params.api,
          sourcePath: preparedTranscript.sourcePath,
          fileHash: preparedTranscript.fileHash,
          transcript,
          maxCandidates: extractorCfg.maxCandidates ?? 10,
        });

        let accepted = 0;
        let persistenceFailure: string | null = null;
        for (const candidate of extracted.candidates) {
          const confidence =
            typeof candidate.confidence === "number" ? candidate.confidence : null;
          if (confidence === null || confidence < EXTRACTOR_MIN_CONFIDENCE) {
            skippedCount += 1;
            continue;
          }
          const alreadyExists = await candidateAlreadyExists({
            pool: params.pool,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            type: candidate.type,
            content: candidate.content,
            ...(candidate.canonicalKey ? { canonicalKey: candidate.canonicalKey } : {}),
          });
          if (alreadyExists) {
            skippedCount += 1;
            continue;
          }
          const stored = await memoryStoreDb({
            pool: params.pool,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            actor: "anchorclaw-maintenance",
            logger: params.api.logger,
            input: {
              content: candidate.content,
              type: candidate.type,
              canonicalKey: candidate.canonicalKey,
              source: "system",
              confidence,
              metadata: {
                extractor: "anchorclaw-maintenance",
                sourceKind: SOURCE_KIND,
                sourcePath: preparedTranscript.sourcePath,
                transcriptHash: preparedTranscript.fileHash,
              },
            },
          });
          if (!stored.ok) {
            persistenceFailure = stored.error;
            break;
          }
          insertedCount += 1;
          accepted += 1;
        }
        if (persistenceFailure) {
          throw new Error(`maintenance candidate store failed (${persistenceFailure})`);
        }

        for (const window of processedWindows) {
          await params.pool.query(
            `
            INSERT INTO memory_daily_block_extraction_windows (
              user_id,
              workspace_id,
              daily_block_id,
              maintenance_run_id,
              daily_path,
              logical_date,
              pipeline_version,
              window_index,
              window_sha256,
              char_start,
              char_end
            )
            VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)
            ON CONFLICT (
              user_id,
              workspace_id,
              daily_block_id,
              pipeline_version,
              window_index
            ) DO NOTHING
            `,
            [
              scope.userId,
              scope.workspaceId,
              window.blockId,
              runId,
              window.path,
              window.logicalDate,
              window.pipelineVersion,
              window.windowIndex,
              window.windowSha256,
              window.charStart,
              window.charEnd,
            ],
          );
        }

        params.api.logger.info(
          `anchorclaw: maintenance extractor accepted ${accepted}/${extracted.candidates.length} candidates`,
        );
      }
    } else if (params.dryRun) {
      skippedCount += heuristicCandidateCount;
    }

    if (runId) {
      await params.pool.query(
        `
        UPDATE memory_maintenance_runs
        SET
          status = 'completed',
          scanned_count = $2,
          heuristic_candidate_count = $3,
          inserted_count = $4,
          skipped_count = $5,
          completed_at = now()
        WHERE id = $1
        `,
        [runId, scannedCount, heuristicCandidateCount, insertedCount, skippedCount],
      );
    }

    return {
      status: "completed",
      runId,
      scannedCount,
      heuristicCandidateCount,
      insertedCount,
      skippedCount,
      dryRun: params.dryRun,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) {
      await params.pool
        .query(
          `
          UPDATE memory_maintenance_runs
          SET
            status = 'failed',
            scanned_count = $2,
            heuristic_candidate_count = $3,
            inserted_count = $4,
            skipped_count = $5,
            last_error_message = $6,
            completed_at = now()
          WHERE id = $1
          `,
          [runId, scannedCount, heuristicCandidateCount, insertedCount, skippedCount, message],
        )
        .catch(() => {});
    }
    return {
      status: "failed",
      runId,
      scannedCount,
      heuristicCandidateCount,
      insertedCount,
      skippedCount,
      dryRun: params.dryRun,
      error: message,
    };
  }
}
