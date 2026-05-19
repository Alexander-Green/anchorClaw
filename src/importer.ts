import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { OpenClawPluginApi } from "./api.js";
import type { AnchorClawConfig } from "./config.js";
import {
  IMPORT_BATCH_LOCK_TIMEOUT_MS,
  IMPORT_BATCH_SIZE,
  IMPORT_BATCH_STATEMENT_TIMEOUT_MS,
  MEMORY_MD_IMPORT_PARSER_VERSION,
} from "./constants.js";
import { isTransientDbError } from "./db-errors.js";
import { resolveUserAndWorkspaceScope } from "./identity.js";
import type { PostgresPool } from "./postgres.js";
import type { DurableCleanupState, DurableImportState, DurableOverallState } from "./plugin/types.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

function normalizeMemoryContent(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function isGenericMemoryHeading(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "memory" || normalized === "long-term memory";
}

function buildHeadingSegments(headingPath: string[]): string[] {
  if (headingPath.length > 1 && isGenericMemoryHeading(headingPath[0] ?? "")) {
    return headingPath.slice(1);
  }
  return headingPath;
}

function buildHeadingTitle(headingPath: string[]): string {
  const segments = buildHeadingSegments(headingPath);
  return segments.join(" > ") || "Memory";
}

function guessItemTypeFromSection(title: string): string {
  const t = title.trim().toLowerCase();
  if (t.includes("fact") || t.includes("preference")) {
    return "fact";
  }
  return "note";
}

type MemoryMdItem = {
  type: string;
  title: string;
  canonicalKey: string;
  content: string;
  metadata: Record<string, unknown>;
};

type MemoryImportRunRow = {
  id: string;
  source_sha256: string;
  status: string;
  cleanup_status: string;
  attempt_count: number;
};

export type WorkspaceImportResult = {
  overall: DurableOverallState;
  import: DurableImportState;
  cleanup: DurableCleanupState;
  reason?: string | null;
  lastImportRunId?: string | null;
  lastSourceSha256?: string | null;
};

function parseMemoryMdToItems(params: { content: string; relPath: string }): MemoryMdItem[] {
  const lines = params.content.split("\n");
  const items: MemoryMdItem[] = [];

  let headingPath: string[] = [];
  let blockLines: string[] = [];

  const flushBlock = () => {
    const content = normalizeMemoryContent(blockLines.join("\n"));
    blockLines = [];
    if (!content) {
      return;
    }

    const title = buildHeadingTitle(headingPath);
    const type = guessItemTypeFromSection(title);
    const keySuffix = buildHeadingSegments(headingPath)
      .map((segment) => slugify(segment))
      .filter(Boolean)
      .join(":");
    const canonicalKey = `${type}:${keySuffix || "memory"}`;
    items.push({
      type,
      title,
      canonicalKey,
      content,
      metadata: {
        legacy_file: params.relPath,
        legacy_heading_path: [...headingPath],
        legacy_format: "memory-md:v1",
      },
    });
  };

  const updateHeadingPath = (level: number, title: string) => {
    flushBlock();
    const nextPath = headingPath.slice(0, Math.max(level - 1, 0));
    nextPath[level - 1] = title.trim();
    headingPath = nextPath;
  };

  for (const rawLine of lines) {
    const line = rawLine ?? "";
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      updateHeadingPath(headingMatch[1]!.length, headingMatch[2]!.trim());
      continue;
    }

    if (!line.trim()) {
      flushBlock();
      continue;
    }

    blockLines.push(line);
  }

  flushBlock();
  return items;
}

function isStubOnlyMemoryMd(content: string): boolean {
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length === 0;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let idx = 0; idx < items.length; idx += size) {
    chunks.push(items.slice(idx, idx + size));
  }
  return chunks;
}

function buildImportKey(item: MemoryMdItem): string {
  return `memory.md:${item.canonicalKey}:${sha256Hex(normalizeMemoryContent(item.content))}`;
}

function classifyImportError(error: unknown): {
  status: "failed_retryable" | "failed_permanent";
  code: string;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientDbError(message)) {
    return {
      status: "failed_retryable",
      code: "transient_db_error",
      message,
    };
  }
  return {
    status: "failed_permanent",
    code: "import_failed",
    message,
  };
}

async function getLatestMemoryImportRun(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  sourceKind: string;
  sourcePath: string;
  sourceSha256: string;
}): Promise<MemoryImportRunRow | null> {
  const result = await params.pool.query<MemoryImportRunRow>(
    `
    SELECT id, source_sha256, status, cleanup_status, attempt_count
    FROM memory_import_runs
    WHERE user_id = $1
      AND workspace_id = $2
      AND source_kind = $3
      AND source_path = $4
      AND source_sha256 = $5
    ORDER BY started_at DESC
    LIMIT 1
  `,
    [params.userId, params.workspaceId, params.sourceKind, params.sourcePath, params.sourceSha256],
  );
  return result.rows[0] ?? null;
}

async function createMemoryImportRun(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  sourceKind: string;
  sourcePath: string;
  sourceSha256: string;
  parsedCount: number;
  metadata: Record<string, unknown>;
}): Promise<{ id: string; attemptCount: number }> {
  const previous = await params.pool.query<{ attempt_count: number }>(
    `
    SELECT attempt_count
    FROM memory_import_runs
    WHERE user_id = $1
      AND workspace_id = $2
      AND source_kind = $3
      AND source_path = $4
      AND source_sha256 = $5
    ORDER BY started_at DESC
    LIMIT 1
  `,
    [params.userId, params.workspaceId, params.sourceKind, params.sourcePath, params.sourceSha256],
  );
  const attemptCount = (previous.rows[0]?.attempt_count ?? 0) + 1;
  const inserted = await params.pool.query<{ id: string }>(
    `
    INSERT INTO memory_import_runs (
      user_id,
      workspace_id,
      source_kind,
      source_path,
      source_sha256,
      parser_version,
      status,
      parsed_count,
      attempt_count,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9::jsonb)
    RETURNING id
  `,
    [
      params.userId,
      params.workspaceId,
      params.sourceKind,
      params.sourcePath,
      params.sourceSha256,
      MEMORY_MD_IMPORT_PARSER_VERSION,
      params.parsedCount,
      attemptCount,
      JSON.stringify(params.metadata),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    throw new Error("failed to create memory import run");
  }
  return { id, attemptCount };
}

async function markMemoryImportRun(params: {
  pool: PostgresPool;
  runId: string;
  status: "completed" | "failed_retryable" | "failed_permanent";
  insertedCount: number;
  skippedCount: number;
  cleanupStatus?: DurableCleanupState;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  await params.pool.query(
    `
    UPDATE memory_import_runs
    SET status = $2,
        inserted_count = $3,
        skipped_count = $4,
        cleanup_status = CASE WHEN $5::text IS NULL THEN cleanup_status ELSE $5::text END,
        last_error_code = $6,
        last_error_message = $7,
        updated_at = now(),
        completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
        cleanup_completed_at = CASE WHEN $5 = 'completed' THEN now() ELSE cleanup_completed_at END
    WHERE id = $1
  `,
    [
      params.runId,
      params.status,
      params.insertedCount,
      params.skippedCount,
      params.cleanupStatus ?? null,
      params.errorCode ?? null,
      params.errorMessage ?? null,
    ],
  );
}

async function updateMemoryImportCleanup(params: {
  pool: PostgresPool;
  runId: string;
  cleanupStatus: DurableCleanupState;
  errorCode?: string;
  errorMessage?: string;
}): Promise<void> {
  await params.pool.query(
    `
    UPDATE memory_import_runs
    SET cleanup_status = $2,
        last_error_code = $3,
        last_error_message = $4,
        updated_at = now(),
        cleanup_completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE cleanup_completed_at END
    WHERE id = $1
  `,
    [params.runId, params.cleanupStatus, params.errorCode ?? null, params.errorMessage ?? null],
  );
}

async function insertMemoryItemBatch(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  items: MemoryMdItem[];
}): Promise<{ insertedCount: number; skippedCount: number }> {
  if (params.items.length === 0) {
    return { insertedCount: 0, skippedCount: 0 };
  }

  const valuesSql: string[] = [];
  const sqlParams: unknown[] = [];
  for (const item of params.items) {
    const base = sqlParams.length;
    valuesSql.push(
      `($${base + 1}, $${base + 2}, $${base + 3}::memory_item_type, 'default', 'active'::memory_item_status, ` +
        `'migration'::memory_item_source, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, '{}'::text[], 50, 80, ` +
        `$${base + 7}, 'anchorclaw-import', 'anchorclaw-import')`,
    );
    sqlParams.push(
      params.userId,
      params.workspaceId,
      item.type,
      item.title,
      item.content,
      JSON.stringify(item.metadata),
      buildImportKey(item),
    );
  }

  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${IMPORT_BATCH_STATEMENT_TIMEOUT_MS}ms'`);
    await client.query(`SET LOCAL lock_timeout = '${IMPORT_BATCH_LOCK_TIMEOUT_MS}ms'`);
    const inserted = await client.query<{ id: string }>(
      `
      INSERT INTO memory_items (
        user_id,
        workspace_id,
        type,
        namespace,
        status,
        source,
        title,
        content,
        metadata,
        tags,
        importance,
        confidence,
        import_key,
        created_by,
        updated_by
      )
      VALUES ${valuesSql.join(",\n")}
      ON CONFLICT (user_id, workspace_id, import_key)
        WHERE status = 'active' AND import_key IS NOT NULL
      DO NOTHING
      RETURNING id
    `,
      sqlParams,
    );
    await client.query("COMMIT");
    return {
      insertedCount: inserted.rows.length,
      skippedCount: params.items.length - inserted.rows.length,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors here; original error is more important
    }
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupMemoryMd(params: {
  api: OpenClawPluginApi;
  workspaceDir: string;
  absPath: string;
  content: string;
  sourceSha256: string;
}): Promise<{ cleanup: DurableCleanupState; reason?: string }> {
  const backupDirRelative = ".openclaw-repair/anchorclaw";
  const stub = [
    "<!--",
    "AnchorClaw note:",
    "This file is intentionally kept empty after migration.",
    `A backup copy of the previous MEMORY.md is stored under ${backupDirRelative}/ (see the .anchorclaw-backup.*.md files).`,
    "Durable memory source-of-truth is Postgres via the AnchorClaw memory plugin.",
    "",
    "Why: OpenClaw bootstrap injects MEMORY.md into prompts. AnchorClaw also injects Postgres-backed durable memory.",
    "Keeping MEMORY.md empty avoids duplicated prompt memory.",
    "",
    "To inspect/export durable memory:",
    "- Use memory_search / memory_get tools, or",
    '- Use memory_get({ lookup: "db-memory/export/MEMORY.md" }) to generate a snapshot.',
    "-->",
  ].join("\n");

  try {
    const current = await fs.readFile(params.absPath, "utf8");
    const currentSha = sha256Hex(current);
    if (currentSha !== params.sourceSha256) {
      return {
        cleanup: "failed",
        reason: "legacy MEMORY.md changed before cleanup; duplicate prompt injection risk remains",
      };
    }
    const backupDir = path.join(params.workspaceDir, ".openclaw-repair", "anchorclaw");
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    const backupPath = path.join(backupDir, `MEMORY.md.anchorclaw-backup.${stamp}.md`);
    await fs.writeFile(backupPath, params.content, "utf8");
    await fs.writeFile(params.absPath, stub, "utf8");
    params.api.logger.info(
      `anchorclaw: cleaned up MEMORY.md after import (backup: ${path.relative(params.workspaceDir, backupPath)})`,
    );
    return { cleanup: "completed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.api.logger.warn(`anchorclaw: failed to stub MEMORY.md after import (${message})`);
    return {
      cleanup: "failed",
      reason: `legacy MEMORY.md cleanup failed; duplicate prompt injection risk remains (${message})`,
    };
  }
}

async function retryExistingCleanupIfNeeded(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  absPath: string;
  content: string;
  sourceSha256: string;
  latestRun: MemoryImportRunRow;
}): Promise<WorkspaceImportResult> {
  if (params.latestRun.cleanup_status === "completed" || !params.cfg.import?.cleanupMemoryMdAfterImport) {
    return {
      overall: "ready",
      import: "ready",
      cleanup: params.latestRun.cleanup_status === "completed" ? "completed" : "not_needed",
      reason: null,
      lastImportRunId: params.latestRun.id,
      lastSourceSha256: params.sourceSha256,
    };
  }

  const cleanupResult = await cleanupMemoryMd({
    api: params.api,
    workspaceDir: params.workspaceDir,
    absPath: params.absPath,
    content: params.content,
    sourceSha256: params.sourceSha256,
  });
  await updateMemoryImportCleanup({
    pool: params.pool,
    runId: params.latestRun.id,
    cleanupStatus: cleanupResult.cleanup,
    errorCode: cleanupResult.cleanup === "failed" ? "cleanup_failed" : undefined,
    errorMessage: cleanupResult.reason,
  });
  return {
    overall: cleanupResult.cleanup === "failed" ? "degraded" : "ready",
    import: "ready",
    cleanup: cleanupResult.cleanup,
    reason: cleanupResult.reason ?? null,
    lastImportRunId: params.latestRun.id,
    lastSourceSha256: params.sourceSha256,
  };
}

async function importMemoryMd(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<WorkspaceImportResult> {
  const relPath = "MEMORY.md";
  const absPath = path.join(params.workspaceDir, relPath);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    return {
      overall: "ready",
      import: "not_needed",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: null,
      lastSourceSha256: null,
    };
  }

  if (isStubOnlyMemoryMd(content)) {
    return {
      overall: "ready",
      import: "not_needed",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: null,
      lastSourceSha256: sha256Hex(content),
    };
  }

  const sourceSha256 = sha256Hex(content);
  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool: params.pool,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    configuredExternalId: params.cfg.identity?.externalId,
  });

  const latestRun = await getLatestMemoryImportRun({
    pool: params.pool,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    sourceKind: "workspace_memory_md",
    sourcePath: relPath,
    sourceSha256,
  });
  if (latestRun?.status === "completed") {
    return retryExistingCleanupIfNeeded({
      api: params.api,
      cfg: params.cfg,
      pool: params.pool,
      workspaceDir: params.workspaceDir,
      absPath,
      content,
      sourceSha256,
      latestRun,
    });
  }

  const items = parseMemoryMdToItems({ content, relPath });
  const run = await createMemoryImportRun({
    pool: params.pool,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    sourceKind: "workspace_memory_md",
    sourcePath: relPath,
    sourceSha256,
    parsedCount: items.length,
    metadata: { legacy_file: relPath, absolute_path: absPath },
  });

  let insertedCount = 0;
  let skippedCount = 0;
  try {
    for (const batch of chunkArray(items, IMPORT_BATCH_SIZE)) {
      const batchResult = await insertMemoryItemBatch({
        pool: params.pool,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        items: batch,
      });
      insertedCount += batchResult.insertedCount;
      skippedCount += batchResult.skippedCount;
    }
  } catch (error) {
    const failure = classifyImportError(error);
    await markMemoryImportRun({
      pool: params.pool,
      runId: run.id,
      status: failure.status,
      insertedCount,
      skippedCount,
      cleanupStatus: "not_needed",
      errorCode: failure.code,
      errorMessage: failure.message,
    });
    return {
      overall: "blocked",
      import: failure.status,
      cleanup: "not_needed",
      reason: `workspace_import_failed: ${failure.message}`,
      lastImportRunId: run.id,
      lastSourceSha256: sourceSha256,
    };
  }

  await markMemoryImportRun({
    pool: params.pool,
    runId: run.id,
    status: "completed",
    insertedCount,
    skippedCount,
    cleanupStatus: params.cfg.import?.cleanupMemoryMdAfterImport ? "failed" : "not_needed",
  });

  if (!params.cfg.import?.cleanupMemoryMdAfterImport) {
    return {
      overall: "ready",
      import: "ready",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: run.id,
      lastSourceSha256: sourceSha256,
    };
  }

  const cleanupResult = await cleanupMemoryMd({
    api: params.api,
    workspaceDir: params.workspaceDir,
    absPath,
    content,
    sourceSha256,
  });
  await updateMemoryImportCleanup({
    pool: params.pool,
    runId: run.id,
    cleanupStatus: cleanupResult.cleanup,
    errorCode: cleanupResult.cleanup === "failed" ? "cleanup_failed" : undefined,
    errorMessage: cleanupResult.reason,
  });
  return {
    overall: cleanupResult.cleanup === "failed" ? "degraded" : "ready",
    import: "ready",
    cleanup: cleanupResult.cleanup,
    reason: cleanupResult.reason ?? null,
    lastImportRunId: run.id,
    lastSourceSha256: sourceSha256,
  };
}

async function ensureImportRecorded(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  relPath: string;
  sha256: string;
  sourceType: string;
  metadata: Record<string, unknown>;
}): Promise<boolean> {
  const existing = await params.pool.query<{ id: string }>(
    `
    SELECT id
    FROM memory_import_files
    WHERE user_id = $1 AND workspace_id = $2 AND rel_path = $3 AND sha256 = $4
    LIMIT 1
  `,
    [params.userId, params.workspaceId, params.relPath, params.sha256],
  );
  if (existing.rows[0]?.id) {
    return false;
  }
  const inserted = await params.pool.query<{ id: string }>(
    `
    INSERT INTO memory_import_files (user_id, workspace_id, rel_path, sha256, source_type, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (user_id, workspace_id, rel_path, sha256) DO NOTHING
    RETURNING id
  `,
    [params.userId, params.workspaceId, params.relPath, params.sha256, params.sourceType, JSON.stringify(params.metadata)],
  );
  return inserted.rows.length > 0;
}

async function removeImportRecord(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  relPath: string;
  sha256: string;
}): Promise<void> {
  await params.pool.query(
    `
    DELETE FROM memory_import_files
    WHERE user_id = $1 AND workspace_id = $2 AND rel_path = $3 AND sha256 = $4
  `,
    [params.userId, params.workspaceId, params.relPath, params.sha256],
  );
}

async function importDailyMemory(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<void> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  let dirents: Dirent[] = [];
  try {
    dirents = (await fs.readdir(memoryDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }

  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool: params.pool,
    workspaceDir: params.workspaceDir,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    configuredExternalId: params.cfg.identity?.externalId,
  });

  for (const entry of dirents) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const relPath = `memory/${entry.name}`;
    const absPath = path.join(memoryDir, entry.name);
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      continue;
    }
    const digest = sha256Hex(content);
    const shouldProceed = await ensureImportRecorded({
      pool: params.pool,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      relPath,
      sha256: digest,
      sourceType: "daily-memory",
      metadata: { legacy_file: relPath, absolute_path: absPath },
    });
    if (!shouldProceed) {
      continue;
    }

    try {
      const inserted = await params.pool.query<{ id: string }>(
        `
        INSERT INTO memory_events (user_id, workspace_id, event_type, content, metadata, tags, created_by)
        VALUES ($1, $2, 'import', $3, $4::jsonb, '{}'::text[], $5)
        RETURNING id
      `,
        [
          scope.userId,
          scope.workspaceId,
          content,
          JSON.stringify({ legacy_file: relPath, legacy_sha256: digest }),
          "anchorclaw-import",
        ],
      );
      if (!inserted.rows[0]?.id) {
        throw new Error(`failed to import ${relPath} into memory_events`);
      }
    } catch (error) {
      await removeImportRecord({
        pool: params.pool,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        relPath,
        sha256: digest,
      });
      params.api.logger.warn(
        `anchorclaw: failed to import ${relPath} into memory_events (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

export async function runOneTimeWorkspaceImport(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<WorkspaceImportResult> {
  const memoryResult = await importMemoryMd(params);
  await importDailyMemory(params);
  return memoryResult;
}
