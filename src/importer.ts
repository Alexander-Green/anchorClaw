import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { OpenClawPluginApi } from "./api.js";
import type { AnchorClawConfig } from "./config.js";
import type { PostgresPool } from "./postgres.js";
import { resolveUserAndWorkspaceScope } from "./identity.js";
import { memoryStoreDb } from "./memory/store.js";

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

function guessItemTypeFromSection(title: string): string {
  const t = title.trim().toLowerCase();
  // MVP: keep import aligned with OpenClaw `MEMORY.md` role (durable facts/preferences + notes).
  // Future: re-enable richer types (profile/config/skill/summary/automation) behind a clear policy.
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

function parseMemoryMdToItems(params: { content: string; relPath: string }): MemoryMdItem[] {
  const lines = params.content.split("\n");
  const items: MemoryMdItem[] = [];

  let currentSectionTitle = "Memory";
  let currentSectionStart = 0;

  const flushSection = (sectionTitle: string, startIndex: number, endIndex: number) => {
    const sectionLines = lines.slice(startIndex, endIndex);
    const sectionBody = sectionLines.join("\n").trim();
    if (!sectionBody) {
      return;
    }

    // If there are ### subsections, create items per subsection.
    const subsectionIndexes: Array<{ title: string; start: number }> = [];
    for (let i = 0; i < sectionLines.length; i += 1) {
      const line = sectionLines[i] ?? "";
      const match = /^###\s+(.+)\s*$/.exec(line);
      if (match) {
        subsectionIndexes.push({ title: match[1]!.trim(), start: i });
      }
    }

    if (subsectionIndexes.length === 0) {
      const type = guessItemTypeFromSection(sectionTitle);
      const canonicalKey = `${type}:${slugify(sectionTitle) || "memory"}`;
      items.push({
        type,
        title: sectionTitle,
        canonicalKey,
        content: sectionBody,
        metadata: {
          legacy_file: params.relPath,
          legacy_heading: sectionTitle,
          legacy_format: "memory-md:v1",
        },
      });
      return;
    }

    const type = guessItemTypeFromSection(sectionTitle);
    for (let idx = 0; idx < subsectionIndexes.length; idx += 1) {
      const current = subsectionIndexes[idx]!;
      const next = subsectionIndexes[idx + 1];
      const subStart = current.start;
      const subEnd = next ? next.start : sectionLines.length;
      const raw = sectionLines.slice(subStart, subEnd).join("\n").trim();
      const body = raw.replace(/^###\s+.+\s*\n?/, "").trim();
      if (!body) {
        continue;
      }
      const title = current.title;
      const canonicalKey = `${type}:${slugify(sectionTitle)}:${slugify(title) || "item"}`;
      items.push({
        type,
        title,
        canonicalKey,
        content: body,
        metadata: {
          legacy_file: params.relPath,
          legacy_heading: sectionTitle,
          legacy_subheading: title,
          legacy_format: "memory-md:v1",
        },
      });
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const match = /^##\s+(.+)\s*$/.exec(line);
    if (match) {
      flushSection(currentSectionTitle, currentSectionStart, i);
      currentSectionTitle = match[1]!.trim();
      currentSectionStart = i + 1;
    }
  }
  flushSection(currentSectionTitle, currentSectionStart, lines.length);
  return items;
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
  await params.pool.query(
    `
    INSERT INTO memory_import_files (user_id, workspace_id, rel_path, sha256, source_type, metadata)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (user_id, workspace_id, rel_path, sha256) DO NOTHING
  `,
    [params.userId, params.workspaceId, params.relPath, params.sha256, params.sourceType, JSON.stringify(params.metadata)],
  );
  return true;
}

async function importMemoryMd(params: {
  api: OpenClawPluginApi;
  cfg: AnchorClawConfig;
  pool: PostgresPool;
  workspaceDir: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<void> {
  const relPath = "MEMORY.md";
  const absPath = path.join(params.workspaceDir, relPath);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    return;
  }
  const digest = sha256Hex(content);

  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool: params.pool,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    configuredExternalId: params.cfg.identity?.externalId,
  });

  const shouldProceed = await ensureImportRecorded({
    pool: params.pool,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    relPath,
    sha256: digest,
    sourceType: "root-memory",
    metadata: { legacy_file: relPath },
  });
  if (!shouldProceed) {
    return;
  }

  const items = parseMemoryMdToItems({ content, relPath });
  for (const item of items) {
    const stored = await memoryStoreDb({
      pool: params.pool,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      actor: "anchorclaw-import",
      logger: params.api.logger,
      input: {
        content: item.content,
        type: item.type,
        canonicalKey: item.canonicalKey,
        title: item.title,
        source: "migration",
        metadata: item.metadata,
      },
    });
    if (!stored.ok) {
      params.api.logger.warn(`anchorclaw: MEMORY.md import item failed (${stored.error})`);
    }
  }

  if (params.cfg.import?.cleanupMemoryMdAfterImport) {
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
      const backupDir = path.join(params.workspaceDir, ".openclaw-repair", "anchorclaw");
      await fs.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
      const backupPath = path.join(backupDir, `MEMORY.md.anchorclaw-backup.${stamp}.md`);
      await fs.writeFile(backupPath, content, "utf8");
      await fs.writeFile(absPath, stub, "utf8");
      params.api.logger.info(
        `anchorclaw: cleaned up MEMORY.md after import (backup: ${path.relative(params.workspaceDir, backupPath)})`,
      );
    } catch (error) {
      params.api.logger.warn(
        `anchorclaw: failed to stub MEMORY.md after import (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
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
      metadata: { legacy_file: relPath },
    });
    if (!shouldProceed) {
      continue;
    }

    // MVP: store the whole file as a single import event.
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
      params.api.logger.warn(`anchorclaw: failed to import ${relPath} into memory_events`);
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
}): Promise<void> {
  // MVP: always attempt idempotent import of legacy memory artifacts.
  await importMemoryMd(params);
  await importDailyMemory(params);
}
