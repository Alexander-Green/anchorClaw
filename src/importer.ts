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
import { appendDailyBlockTx, parseLogicalDateFromDailyPath } from "./memory/daily.js";
import type { PostgresPool } from "./postgres.js";
import type { DurableCleanupState, DurableImportState, DurableOverallState, LegacyFileState } from "./plugin/types.js";

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

export type LegacyMemoryMdScan = {
  path: "MEMORY.md";
  state: LegacyFileState;
  sha256: string | null;
  importedSameSha: boolean;
};

export type LegacyDailyFileScan = {
  path: string;
  logicalDate: string | null;
  sha256: string | null;
  supported: boolean;
  importedSameSha: boolean;
  state: "pending" | "already_imported_active" | "unsupported" | "unreadable";
  error?: string;
};

export type LegacyWorkspaceScanResult = {
  sourceDir: string;
  targetWorkspaceDir: string;
  workspaceDir: string;
  memoryMd: LegacyMemoryMdScan;
  dailyFiles: LegacyDailyFileScan[];
  activeLegacyCount: number;
  pendingCount: number;
  unsupportedCount: number;
  unreadableCount: number;
  hasActiveLegacy: boolean;
};

export type LegacyWorkspaceImportSummary = {
  scan: LegacyWorkspaceScanResult;
  memoryMdResult: WorkspaceImportResult;
  dailyImportedCount: number;
  dailyArchivedCount: number;
  dailySkippedImportedCount: number;
  dailyUnsupportedCount: number;
};

type LegacyWorkspaceBinding = {
  sourceDir?: string;
  targetWorkspaceDir?: string;
  workspaceDir?: string;
};

function resolveLegacySourceDir(params: LegacyWorkspaceBinding): string {
  return path.resolve(params.sourceDir ?? params.workspaceDir ?? params.targetWorkspaceDir ?? ".");
}

function resolveLegacyTargetWorkspaceDir(params: LegacyWorkspaceBinding): string {
  return path.resolve(params.targetWorkspaceDir ?? params.workspaceDir ?? params.sourceDir ?? ".");
}

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
  sourceDir: string;
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
    const backupDir = path.join(params.sourceDir, ".openclaw-repair", "anchorclaw");
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
    const backupPath = path.join(backupDir, `MEMORY.md.anchorclaw-backup.${stamp}.md`);
    await fs.writeFile(backupPath, params.content, "utf8");
    await fs.writeFile(params.absPath, stub, "utf8");
    params.api.logger.info(
      `anchorclaw: cleaned up MEMORY.md after import (backup: ${path.relative(params.sourceDir, backupPath)})`,
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

function buildArchiveStamp() {
  return new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
}

async function archiveLegacyFile(params: {
  sourceDir: string;
  absPath: string;
  archiveSubdir: string;
  fileName: string;
  sha256: string;
}): Promise<string> {
  const archiveDir = path.join(params.sourceDir, ".openclaw-repair", "anchorclaw", params.archiveSubdir);
  await fs.mkdir(archiveDir, { recursive: true });
  const ext = path.extname(params.fileName);
  const baseName = path.basename(params.fileName, ext);
  const archiveName = `${baseName}.${buildArchiveStamp()}.sha-${params.sha256.slice(0, 12)}${ext || ".md"}`;
  const archivePath = path.join(archiveDir, archiveName);
  await fs.rename(params.absPath, archivePath);
  return path.relative(params.sourceDir, archivePath);
}

async function retryExistingCleanupIfNeeded(params: {
  api: OpenClawPluginApi;
  pool: PostgresPool;
  sourceDir: string;
  absPath: string;
  content: string;
  sourceSha256: string;
  latestRun: MemoryImportRunRow;
  cleanupMemoryMdAfterImport: boolean;
}): Promise<WorkspaceImportResult> {
  if (!params.cleanupMemoryMdAfterImport) {
    return {
      overall: "ready",
      import: "ready",
      cleanup: "not_needed",
      reason: null,
      lastImportRunId: params.latestRun.id,
      lastSourceSha256: params.sourceSha256,
    };
  }

  const cleanupResult = await cleanupMemoryMd({
    api: params.api,
    sourceDir: params.sourceDir,
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
  workspaceDir?: string;
  sourceDir?: string;
  targetWorkspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  cleanupMemoryMdAfterImport: boolean;
}): Promise<WorkspaceImportResult> {
  const sourceDir = resolveLegacySourceDir(params);
  const targetWorkspaceDir = resolveLegacyTargetWorkspaceDir(params);
  const relPath = "MEMORY.md";
  const absPath = path.join(sourceDir, relPath);
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
    workspaceDir: targetWorkspaceDir,
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
      pool: params.pool,
      sourceDir,
      absPath,
      content,
      sourceSha256,
      latestRun,
      cleanupMemoryMdAfterImport: params.cleanupMemoryMdAfterImport,
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
    cleanupStatus: params.cleanupMemoryMdAfterImport ? "failed" : "not_needed",
  });

  if (!params.cleanupMemoryMdAfterImport) {
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
    sourceDir,
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

async function hasImportRecord(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  relPath: string;
  sha256: string;
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
  return Boolean(existing.rows[0]?.id);
}

async function importDailyMemory(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir?: string;
  sourceDir?: string;
  targetWorkspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  archiveImportedFiles: boolean;
}): Promise<{
  importedCount: number;
  archivedCount: number;
  skippedImportedCount: number;
  unsupportedCount: number;
}> {
  const sourceDir = resolveLegacySourceDir(params);
  const targetWorkspaceDir = resolveLegacyTargetWorkspaceDir(params);
  const memoryDir = path.join(sourceDir, "memory");
  let dirents: Dirent[] = [];
  try {
    dirents = (await fs.readdir(memoryDir, { withFileTypes: true })) as Dirent[];
  } catch {
    return {
      importedCount: 0,
      archivedCount: 0,
      skippedImportedCount: 0,
      unsupportedCount: 0,
    };
  }

  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool: params.pool,
    workspaceDir: targetWorkspaceDir,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    configuredExternalId: params.cfg.identity?.externalId,
  });

  let importedCount = 0;
  let archivedCount = 0;
  let skippedImportedCount = 0;
  let unsupportedCount = 0;

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
    const alreadyImported = await hasImportRecord({
      pool: params.pool,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      relPath,
      sha256: digest,
    });

    try {
      const logicalDate = parseLogicalDateFromDailyPath(relPath);
      if (!logicalDate) {
        unsupportedCount += 1;
        params.api.logger.warn(`anchorclaw: skipping unsupported legacy daily path ${relPath}`);
        continue;
      }
      if (!alreadyImported) {
        const client = await params.pool.connect();
        try {
          await client.query("BEGIN");
          await appendDailyBlockTx({
            client,
            userId: scope.userId,
            workspaceId: scope.workspaceId,
            logicalDate,
            path: relPath,
            content,
            sourceKind: "legacy_import",
            sourcePath: absPath,
            metadata: {
              legacy_file: relPath,
              legacy_sha256: digest,
              absolute_path: absPath,
            },
            actor: "anchorclaw-import",
            conflictPolicy: "reject",
            auditOperationInsert: "daily_legacy_import",
          });
          const recorded = await client.query<{ id: string }>(
            `
            INSERT INTO memory_import_files (
              user_id, workspace_id, rel_path, sha256, source_type, metadata
            )
            VALUES ($1, $2, $3, $4, 'daily-memory', $5::jsonb)
            ON CONFLICT (user_id, workspace_id, rel_path, sha256) DO NOTHING
            RETURNING id
            `,
            [
              scope.userId,
              scope.workspaceId,
              relPath,
              digest,
              JSON.stringify({ legacy_file: relPath, absolute_path: absPath }),
            ],
          );
          if (!recorded.rows[0]?.id) {
            throw new Error(`failed to record daily import ${relPath}`);
          }
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Best-effort rollback; preserve the original import error.
          }
          throw error;
        } finally {
          client.release();
        }
        importedCount += 1;
      } else {
        skippedImportedCount += 1;
      }
      if (params.archiveImportedFiles) {
        const archiveRelPath = await archiveLegacyFile({
          sourceDir,
          absPath,
          archiveSubdir: "legacy-daily",
          fileName: entry.name,
          sha256: digest,
        });
        archivedCount += 1;
        params.api.logger.info(`anchorclaw: archived legacy daily file ${relPath} -> ${archiveRelPath}`);
      }
    } catch (error) {
      params.api.logger.warn(
        `anchorclaw: failed to import ${relPath} into memory_daily_entries (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  return {
    importedCount,
    archivedCount,
    skippedImportedCount,
    unsupportedCount,
  };
}

export async function scanLegacyWorkspace(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir?: string;
  sourceDir?: string;
  targetWorkspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<LegacyWorkspaceScanResult> {
  const sourceDir = resolveLegacySourceDir(params);
  const targetWorkspaceDir = resolveLegacyTargetWorkspaceDir(params);
  const memoryPath = path.join(sourceDir, "MEMORY.md");
  let memoryMd: LegacyMemoryMdScan = {
    path: "MEMORY.md",
    state: "absent",
    sha256: null,
    importedSameSha: false,
  };
  try {
    const content = await fs.readFile(memoryPath, "utf8");
    const sourceSha256 = sha256Hex(content);
    if (isStubOnlyMemoryMd(content)) {
      memoryMd = {
        path: "MEMORY.md",
        state: "stub",
        sha256: sourceSha256,
        importedSameSha: false,
      };
    } else {
      const scope = await resolveUserAndWorkspaceScope({
        api: params.api,
        pool: params.pool,
        workspaceDir: targetWorkspaceDir,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        configuredExternalId: params.cfg.identity?.externalId,
      });
      const latestRun = await getLatestMemoryImportRun({
        pool: params.pool,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        sourceKind: "workspace_memory_md",
        sourcePath: "MEMORY.md",
        sourceSha256,
      });
      const importedSameSha = latestRun?.status === "completed";
      memoryMd = {
        path: "MEMORY.md",
        state: importedSameSha ? "already_imported_active" : "pending",
        sha256: sourceSha256,
        importedSameSha,
      };
    }
  } catch {
    // ignore missing MEMORY.md
  }

  const dailyFiles: LegacyDailyFileScan[] = [];
  const memoryDir = path.join(sourceDir, "memory");
  try {
    const dirents = (await fs.readdir(memoryDir, { withFileTypes: true })) as Dirent[];
    const scope = await resolveUserAndWorkspaceScope({
      api: params.api,
      pool: params.pool,
      workspaceDir: targetWorkspaceDir,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      configuredExternalId: params.cfg.identity?.externalId,
    });
    for (const entry of dirents) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const relPath = `memory/${entry.name}`;
      const absPath = path.join(memoryDir, entry.name);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf8");
      } catch (error) {
        dailyFiles.push({
          path: relPath,
          logicalDate: null,
          sha256: null,
          supported: false,
          importedSameSha: false,
          state: "unreadable",
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const digest = sha256Hex(content);
      const logicalDate = parseLogicalDateFromDailyPath(relPath);
      if (!logicalDate) {
        dailyFiles.push({
          path: relPath,
          logicalDate: null,
          sha256: digest,
          supported: false,
          importedSameSha: false,
          state: "unsupported",
        });
        continue;
      }
      const importedSameSha = await hasImportRecord({
        pool: params.pool,
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        relPath,
        sha256: digest,
      });
      dailyFiles.push({
        path: relPath,
        logicalDate,
        sha256: digest,
        supported: true,
        importedSameSha,
        state: importedSameSha ? "already_imported_active" : "pending",
      });
    }
  } catch {
    // ignore missing memory dir
  }

  const activeLegacyCount =
    (memoryMd.state === "pending" || memoryMd.state === "already_imported_active" ? 1 : 0) +
    dailyFiles.filter((file) => file.state === "pending" || file.state === "already_imported_active").length;
  const pendingCount =
    (memoryMd.state === "pending" ? 1 : 0) + dailyFiles.filter((file) => file.state === "pending").length;
  const unsupportedCount = dailyFiles.filter((file) => file.state === "unsupported").length;
  const unreadableCount = dailyFiles.filter((file) => file.state === "unreadable").length;

  return {
    sourceDir,
    targetWorkspaceDir,
    workspaceDir: sourceDir,
    memoryMd,
    dailyFiles,
    activeLegacyCount,
    pendingCount,
    unsupportedCount,
    unreadableCount,
    hasActiveLegacy: activeLegacyCount > 0,
  };
}

export async function runLegacyWorkspaceImport(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir?: string;
  sourceDir?: string;
  targetWorkspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  cleanupMemoryMdAfterImport?: boolean;
  archiveImportedFiles?: boolean;
}): Promise<LegacyWorkspaceImportSummary> {
  const scan = await scanLegacyWorkspace(params);
  const memoryMdResult = await importMemoryMd({
    ...params,
    cleanupMemoryMdAfterImport: params.cleanupMemoryMdAfterImport ?? true,
  });
  const dailyResult = await importDailyMemory({
    ...params,
    archiveImportedFiles: params.archiveImportedFiles ?? true,
  });
  return {
    scan,
    memoryMdResult,
    dailyImportedCount: dailyResult.importedCount,
    dailyArchivedCount: dailyResult.archivedCount,
    dailySkippedImportedCount: dailyResult.skippedImportedCount,
    dailyUnsupportedCount: dailyResult.unsupportedCount,
  };
}

export async function runOneTimeWorkspaceImport(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir?: string;
  sourceDir?: string;
  targetWorkspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
  cleanupMemoryMdAfterImport?: boolean;
  archiveImportedFiles?: boolean;
}): Promise<WorkspaceImportResult> {
  const result = await runLegacyWorkspaceImport(params);
  return result.memoryMdResult;
}
