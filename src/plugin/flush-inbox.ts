import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import type { PostgresPool } from "../postgres.js";
import { appendDailyBlockTx, resolveDailyLogicalDate } from "../memory/daily.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceTarget,
  RUNTIME_WORKSPACE_UNAVAILABLE,
} from "./runtime-workspace.js";

const FLUSH_INBOX_ROOT = ".anchorclaw/flush-inbox";
const FLUSH_INBOX_SOURCE_TYPE = "flush-inbox";

type FlushInboxDrainStats = {
  scannedFiles: number;
  importedFiles: number;
  skippedImportedFiles: number;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildFlushInboxRelativePath(params: { logicalDate: string; nowMs?: number }): string {
  const now = new Date(Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now());
  const stamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  return path.posix.join(FLUSH_INBOX_ROOT, params.logicalDate, `flush-${stamp}-${randomUUID()}.md`);
}

function formatFlushInboxBlock(params: { content: string; relPath: string; importedAtIso: string }): string {
  return [
    `## Compaction Flush - ${params.importedAtIso}`,
    `- Source: ${params.relPath}`,
    "",
    params.content.trim(),
  ].join("\n");
}

async function importFlushInboxFile(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  actor: string;
  logicalDate: string;
  relPath: string;
  absPath: string;
  content: string;
  importedAtIso: string;
}): Promise<"imported" | "already_imported"> {
  const digest = sha256Hex(params.content);
  const targetPath = `memory/${params.logicalDate}.md`;
  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");
    const insertedLedger = await client.query<{ id: string }>(
      `
      INSERT INTO memory_import_files (user_id, workspace_id, rel_path, sha256, source_type, metadata)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (user_id, workspace_id, rel_path, sha256) DO NOTHING
      RETURNING id
      `,
      [
        params.userId,
        params.workspaceId,
        params.relPath,
        digest,
        FLUSH_INBOX_SOURCE_TYPE,
        JSON.stringify({
          source_kind: "compaction_flush",
          logical_date: params.logicalDate,
          absolute_path: params.absPath,
          target_path: targetPath,
        }),
      ],
    );
    if (!insertedLedger.rows[0]?.id) {
      await client.query("COMMIT");
      return "already_imported";
    }

    const block = formatFlushInboxBlock({
      content: params.content,
      relPath: params.relPath,
      importedAtIso: params.importedAtIso,
    });
    await appendDailyBlockTx({
      client,
      userId: params.userId,
      workspaceId: params.workspaceId,
      logicalDate: params.logicalDate,
      path: targetPath,
      content: block,
      sourceKind: "compaction_flush",
      sourcePath: params.relPath,
      metadata: {
        flushInbox: true,
        flushInboxPath: params.relPath,
        flushInboxSha256: digest,
        importedAt: params.importedAtIso,
      },
      actor: params.actor,
      auditOperationInsert: "daily_flush_insert",
      auditOperationUpdate: "daily_flush_update",
    });
    await client.query("COMMIT");
    return "imported";
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback; the original error below is more actionable.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function walkFlushInboxFiles(absDir: string, relDir: string): Promise<Array<{ absPath: string; relPath: string }>> {
  const entries = (await fs.readdir(absDir, { withFileTypes: true })) as Dirent[];
  const files: Array<{ absPath: string; relPath: string }> = [];
  for (const entry of entries) {
    const nextAbs = path.join(absDir, entry.name);
    const nextRel = path.posix.join(relDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFlushInboxFiles(nextAbs, nextRel)));
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    files.push({ absPath: nextAbs, relPath: nextRel });
  }
  return files.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

export async function drainFlushInbox(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  workspaceDir?: string;
}): Promise<FlushInboxDrainStats> {
  if (params.ctx.disabledReason || !params.ctx.cfg) {
    return { scannedFiles: 0, importedFiles: 0, skippedImportedFiles: 0 };
  }
  const workspaceDir =
    params.workspaceDir ??
    resolveRuntimeWorkspaceTarget({ api: params.api })?.workspaceDir;
  if (!workspaceDir) {
    throw new Error(RUNTIME_WORKSPACE_UNAVAILABLE);
  }
  const inboxRootAbs = path.join(workspaceDir, ...FLUSH_INBOX_ROOT.split("/"));
  let files: Array<{ absPath: string; relPath: string }> = [];
  try {
    files = await walkFlushInboxFiles(inboxRootAbs, FLUSH_INBOX_ROOT);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ENOENT") {
      return { scannedFiles: 0, importedFiles: 0, skippedImportedFiles: 0 };
    }
    throw error;
  }
  if (files.length === 0) {
    return { scannedFiles: 0, importedFiles: 0, skippedImportedFiles: 0 };
  }

  await params.ctx.ensureReady();
  const pool = params.ctx.getPool();
  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool,
    workspaceDir,
    agentId: (params.api as any)?.runtime?.agentId,
    sessionKey: (params.api as any)?.runtime?.sessionKey,
    configuredExternalId: params.ctx.cfg.identity?.externalId,
  });

  let importedFiles = 0;
  let skippedImportedFiles = 0;
  for (const file of files) {
    const logicalDate = resolveDailyLogicalDate({
      explicitDate: path.posix.basename(path.posix.dirname(file.relPath)),
    });
    const content = await fs.readFile(file.absPath, "utf8");
    if (!content.trim()) {
      await fs.unlink(file.absPath);
      continue;
    }
    const result = await importFlushInboxFile({
      pool,
      userId: scope.userId,
      workspaceId: scope.workspaceId,
      actor: params.ctx.resolveActor(),
      logicalDate,
      relPath: file.relPath,
      absPath: file.absPath,
      content,
      importedAtIso: new Date().toISOString(),
    });
    if (result === "imported") {
      importedFiles += 1;
    } else {
      skippedImportedFiles += 1;
    }
    await fs.unlink(file.absPath);
  }

  return {
    scannedFiles: files.length,
    importedFiles,
    skippedImportedFiles,
  };
}

export function registerAnchorClawFlushInboxHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}) {
  const { api, ctx } = params;
  const handler = async () => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }
    try {
      const stats = await drainFlushInbox({ api, ctx });
      if (stats.scannedFiles > 0) {
        api.logger.info(
          `anchorclaw: flush inbox drain completed (scanned=${stats.scannedFiles}, imported=${stats.importedFiles}, skipped=${stats.skippedImportedFiles})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: flush inbox drain failed (${message})`);
    }
    return undefined;
  };

  const registerHookAny = (api as any).registerHook;
  if (typeof registerHookAny !== "function") {
    return;
  }
  try {
    registerHookAny("after_compaction", handler, {
      name: "anchorclaw-flush-inbox-drain",
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.debug?.(`anchorclaw: named flush inbox hook registration failed, trying legacy signature (${message})`);
  }
  registerHookAny("after_compaction", handler);
}

export function createFlushInboxPlanResolver(params: { timezone?: string }) {
  return ({ nowMs }: { nowMs?: number }) => {
    const logicalDate = resolveDailyLogicalDate({
      nowMs,
      timezone: params.timezone,
    });
    const relativePath = buildFlushInboxRelativePath({ logicalDate, nowMs });
    return {
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes: 2_000_000,
      reserveTokensFloor: 20_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      systemPrompt:
        "Save important current-session context to the provided flush inbox file. Use append-only write to that path only. NO_REPLY.",
      relativePath,
    };
  };
}
