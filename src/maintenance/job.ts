import type { OpenClawPluginApi } from "../api.js";
import type { AnchorClawConfig } from "../config.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import type { PostgresPool } from "../postgres.js";
import { memoryStoreDb } from "../memory/store.js";
import { extractMaintenanceCandidates } from "./extractor.js";

const SOURCE_KIND = "episodic_events";

type ExistingContentRow = { content: string };
type EpisodicRow = {
  id: string;
  event_type: string;
  content: string;
  created_at: string;
};

type PreparedTranscript = {
  transcript: string;
  includedRows: EpisodicRow[];
};

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

function renderEpisodicLine(row: EpisodicRow): string {
  return `[${row.created_at}] [${row.event_type}] ${row.content}`;
}

function prepareTranscript(rows: EpisodicRow[], maxChars: number): PreparedTranscript {
  const safeMaxChars = Math.max(1, maxChars);
  const lines: string[] = [];
  const includedRows: EpisodicRow[] = [];
  let length = 0;

  for (const row of rows) {
    const line = renderEpisodicLine(row);
    const addition = lines.length === 0 ? line.length : line.length + 1;
    if (length + addition > safeMaxChars) {
      break;
    }
    lines.push(line);
    includedRows.push(row);
    length += addition;
  }

  if (includedRows.length === 0 && rows.length > 0) {
    throw new Error(
      `maintenance transcript window too small for a single episodic row (maxCharsPerRun=${safeMaxChars})`,
    );
  }

  return {
    transcript: lines.join("\n"),
    includedRows,
  };
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
    const episodicRows = await params.pool.query<EpisodicRow>(
      `
      SELECT id, event_type, content, created_at
      FROM memory_episodic
      WHERE user_id = $1
        AND workspace_id = $2
        AND is_archived = false
      ORDER BY created_at ASC, id ASC
      LIMIT $3
      `,
      [scope.userId, scope.workspaceId, params.batchSize],
    );
    const maxChars = params.cfg.maintenance?.extractor?.maxCharsPerRun ?? 12_000;
    const preparedTranscript = prepareTranscript(episodicRows.rows, maxChars);
    const transcript = preparedTranscript.transcript;
    const archivalRows = preparedTranscript.includedRows;
    scannedCount = archivalRows.length;
    heuristicCandidateCount = archivalRows.filter((row) => isDurableCandidate(row.content)).length;

    if (!params.dryRun && archivalRows.length > 0) {
      const extractorCfg = params.cfg.maintenance?.extractor;
      let shouldArchiveRows = false;
      if (!extractorCfg?.enabled) {
        skippedCount += heuristicCandidateCount;
        params.api.logger.warn(
          "anchorclaw: maintenance extractor is disabled; non-dry-run promotion skipped",
        );
      } else {
        const extracted = await extractMaintenanceCandidates({
          agentId: extractorCfg.agentId ?? "main",
          sourcePath: "episodic",
          fileHash: "episodic",
          transcript,
          maxCandidates: extractorCfg.maxCandidates ?? 20,
        });
        let accepted = 0;
        let persistenceFailure: string | null = null;
        for (const candidate of extracted.candidates) {
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
              metadata: {
                extractor: "anchorclaw-maintenance",
                sourceKind: "episodic",
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
        params.api.logger.info(
          `anchorclaw: maintenance extractor accepted ${accepted}/${extracted.candidates.length} candidates`,
        );
        shouldArchiveRows = true;
      }

      const ids = shouldArchiveRows ? archivalRows.map((row) => row.id) : [];
      if (ids.length > 0) {
        await params.pool.query(
          `
          UPDATE memory_episodic
          SET is_archived = true
          WHERE user_id = $1
            AND workspace_id = $2
            AND id = ANY($3::uuid[])
          `,
          [scope.userId, scope.workspaceId, ids],
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
