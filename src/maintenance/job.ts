import { createHash } from "node:crypto";

import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { memoryStoreDb } from "../memory/store.js";
import type { PostgresPool } from "../postgres.js";
import { extractMaintenanceCandidates } from "./extractor.js";

const SOURCE_KIND = "daily_entries";
const DAILY_WINDOW_HEADER_RESERVE = 128;
const EXTRACTOR_ALLOWED_DAILY_SOURCE_KINDS = ["memory_log"] as const;
const EXTRACTOR_MIN_CONFIDENCE = 80;

type ExistingContentRow = { content: string };

type DailyEntryRow = {
  id: string;
  path: string;
  logical_date: string;
  content: string;
  content_sha256: string;
  source_kind: string;
  updated_at: string;
};

type ProcessedWindowRow = {
  daily_entry_id: string;
  content_sha256: string;
  window_index: number;
};

type DailyWindow = {
  dailyEntryId: string;
  path: string;
  logicalDate: string;
  contentSha256: string;
  updatedAt: string;
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

function splitDailyIntoWindows(row: DailyEntryRow, maxChars: number): DailyWindow[] {
  const normalized = row.content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const safeMaxChars = Math.max(1, maxChars - DAILY_WINDOW_HEADER_RESERVE);
  const rawBlocks = normalized
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter(Boolean);

  let searchStart = 0;
  const blocks = rawBlocks.map((block) => {
    const start = normalized.indexOf(block, searchStart);
    const safeStart = start >= 0 ? start : searchStart;
    searchStart = safeStart + block.length;
    return {
      text: block,
      start: safeStart,
    };
  });

  const windows: DailyWindow[] = [];
  let windowIndex = 0;
  let currentParts: string[] = [];
  let currentStart = 0;
  let currentEnd = 0;

  const flushCurrent = () => {
    if (currentParts.length === 0) {
      return;
    }
    const content = currentParts.join("\n\n");
    windows.push({
      dailyEntryId: row.id,
      path: row.path,
      logicalDate: row.logical_date,
      contentSha256: row.content_sha256,
      updatedAt: row.updated_at,
      windowIndex,
      windowSha256: sha256Hex(content),
      charStart: currentStart,
      charEnd: currentEnd,
      content,
    });
    windowIndex += 1;
    currentParts = [];
    currentStart = 0;
    currentEnd = 0;
  };

  for (const block of blocks) {
    const blockLength = block.text.length;
    if (blockLength > safeMaxChars) {
      flushCurrent();
      for (let offset = 0; offset < block.text.length; offset += safeMaxChars) {
        const slice = block.text.slice(offset, offset + safeMaxChars);
        const charStart = block.start + offset;
        const charEnd = charStart + slice.length;
        windows.push({
          dailyEntryId: row.id,
          path: row.path,
          logicalDate: row.logical_date,
          contentSha256: row.content_sha256,
          updatedAt: row.updated_at,
          windowIndex,
          windowSha256: sha256Hex(slice),
          charStart,
          charEnd,
          content: slice,
        });
        windowIndex += 1;
      }
      continue;
    }

    const currentLength = currentParts.length === 0 ? 0 : currentParts.join("\n\n").length;
    const addition = currentParts.length === 0 ? blockLength : blockLength + 2;
    if (currentLength + addition > safeMaxChars) {
      flushCurrent();
    }

    if (currentParts.length === 0) {
      currentStart = block.start;
      currentEnd = block.start + block.text.length;
      currentParts = [block.text];
      continue;
    }

    currentParts.push(block.text);
    currentEnd = block.start + block.text.length;
  }

  flushCurrent();
  return windows;
}

function renderDailyWindow(window: DailyWindow): string {
  return [
    `Source: ${window.path}`,
    `Logical-Date: ${window.logicalDate}`,
    `Window: ${window.windowIndex + 1}`,
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
  if (first.path === last.path && first.windowIndex === last.windowIndex) {
    return `${first.path}#window=${first.windowIndex + 1}`;
  }
  return `${first.path}#window=${first.windowIndex + 1}..${last.path}#window=${last.windowIndex + 1}`;
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
  return `${window.dailyEntryId}:${window.contentSha256}:${window.windowIndex}`;
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

  const firstDailyEntryId = pendingWindows[0]?.dailyEntryId;
  if (!firstDailyEntryId) {
    return [];
  }

  return pendingWindows
    .filter((window) => window.dailyEntryId === firstDailyEntryId)
    .slice(0, Math.max(1, params.batchSize));
}

async function selectPendingWindowsPage(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  batchSize: number;
  maxChars: number;
}): Promise<DailyWindow[]> {
  const pageSize = Math.max(1, params.batchSize);

  for (let offset = 0; ; offset += pageSize) {
    const dailyRows = await params.pool.query<DailyEntryRow>(
      `
      SELECT id, path, logical_date::text AS logical_date, content, content_sha256, source_kind, updated_at
      FROM memory_daily_entries
      WHERE user_id = $1
        AND workspace_id = $2
        AND source_kind = ANY($3::text[])
      ORDER BY logical_date ASC, updated_at ASC, id ASC
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

    if ((dailyRows.rowCount ?? 0) === 0) {
      return [];
    }

    const allWindows = dailyRows.rows.flatMap((row) => splitDailyIntoWindows(row, params.maxChars));
    const dailyEntryIds = Array.from(new Set(allWindows.map((window) => window.dailyEntryId)));
    const processedRows =
      dailyEntryIds.length > 0
        ? await params.pool.query<ProcessedWindowRow>(
            `
            SELECT daily_entry_id, content_sha256, window_index
            FROM memory_daily_extraction_windows
            WHERE user_id = $1
              AND workspace_id = $2
              AND daily_entry_id = ANY($3::uuid[])
            `,
            [params.userId, params.workspaceId, dailyEntryIds],
          )
        : { rows: [], rowCount: 0 };

    const processedKeys = new Set(
      processedRows.rows.map((row) => `${row.daily_entry_id}:${row.content_sha256}:${row.window_index}`),
    );

    const pendingWindows = selectPendingWindowsForRun({
      allWindows,
      processedKeys,
      batchSize: params.batchSize,
    });
    if (pendingWindows.length > 0) {
      return pendingWindows;
    }

    if ((dailyRows.rowCount ?? 0) < pageSize) {
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
      maxChars,
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
            INSERT INTO memory_daily_extraction_windows (
              user_id,
              workspace_id,
              daily_entry_id,
              maintenance_run_id,
              daily_path,
              logical_date,
              content_sha256,
              window_index,
              window_sha256,
              char_start,
              char_end
            )
            VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)
            ON CONFLICT (user_id, workspace_id, daily_entry_id, content_sha256, window_index) DO NOTHING
            `,
            [
              scope.userId,
              scope.workspaceId,
              window.dailyEntryId,
              runId,
              window.path,
              window.logicalDate,
              window.contentSha256,
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
