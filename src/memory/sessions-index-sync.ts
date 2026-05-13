import type { PostgresPool } from "../postgres.js";
import path from "node:path";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import { resolveSessionsDirForAgent } from "./sessions.js";
import { normalizeSessionLookupPath } from "./sessions-index.js";

function splitIndexedLines(content: string): string[] {
  return content.split("\n");
}

async function normalizeTargetSessionFiles(params: {
  sessionFiles?: string[];
  agentId: string;
}): Promise<string[] | null> {
  if (!Array.isArray(params.sessionFiles) || params.sessionFiles.length === 0) {
    return null;
  }
  const sessionsDir = await resolveSessionsDirForAgent(params.agentId);
  const normalized: string[] = [];
  for (const raw of params.sessionFiles) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    const lookup = normalizeSessionLookupPath(trimmed);
    if (lookup) {
      const parts = lookup.split("/");
      const lookupAgentId = parts[1];
      const fileName = parts[2];
      if (lookupAgentId && fileName) {
        const lookupSessionsDir = await resolveSessionsDirForAgent(lookupAgentId);
        normalized.push(path.join(lookupSessionsDir, fileName));
      } else if (fileName) {
        normalized.push(path.join(sessionsDir, fileName));
      }
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

export async function syncSessionsIndexDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  agentId: string;
  force?: boolean;
  sessionFiles?: string[];
}): Promise<{
  indexedFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  removedFiles: number;
}> {
  const targetFiles = await normalizeTargetSessionFiles({
    sessionFiles: params.sessionFiles,
    agentId: params.agentId,
  });
  const allFiles = targetFiles ?? (await listSessionFilesForAgent(params.agentId));
  const activePaths = new Set<string>();

  let indexedFiles = 0;
  let updatedFiles = 0;
  let skippedFiles = 0;

  for (const absPath of allFiles) {
    const entry = await buildSessionEntry(absPath);
    if (!entry) {
      skippedFiles += 1;
      continue;
    }

    const probe = await params.pool.query<{ id: string; hash: string }>(
      `
      SELECT id, hash
      FROM session_index_files
      WHERE user_id = $1
        AND workspace_id = $2
        AND path = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, entry.path],
    );
    const existing = probe.rows[0];
    activePaths.add(entry.path);
    if (!params.force && existing?.hash === entry.hash) {
      skippedFiles += 1;
      continue;
    }

    const lines = splitIndexedLines(entry.content);
    const client = await params.pool.connect();
    try {
      await client.query("BEGIN");
      const upsert = await client.query<{ id: string }>(
        `
        INSERT INTO session_index_files (
          user_id,
          workspace_id,
          agent_id,
          path,
          abs_path,
          hash,
          mtime_ms,
          size_bytes,
          line_count,
          indexed_at,
          updated_at,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now(), $10::jsonb)
        ON CONFLICT (user_id, workspace_id, path)
        DO UPDATE SET
          agent_id = EXCLUDED.agent_id,
          abs_path = EXCLUDED.abs_path,
          hash = EXCLUDED.hash,
          mtime_ms = EXCLUDED.mtime_ms,
          size_bytes = EXCLUDED.size_bytes,
          line_count = EXCLUDED.line_count,
          indexed_at = now(),
          updated_at = now(),
          metadata = EXCLUDED.metadata
        RETURNING id
      `,
        [
          params.userId,
          params.workspaceId,
          params.agentId,
          entry.path,
          absPath,
          entry.hash,
          entry.mtimeMs,
          entry.size,
          lines.length,
          JSON.stringify({
            sdkPath: sessionPathForFile(absPath),
            generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
            generatedByCronRun: entry.generatedByCronRun === true,
          }),
        ],
      );
      const fileId = upsert.rows[0]?.id;
      if (!fileId) {
        throw new Error("session index upsert failed: missing file id");
      }

      await client.query(`DELETE FROM session_index_chunks WHERE file_id = $1`, [fileId]);

      for (let idx = 0; idx < lines.length; idx += 1) {
        const text = lines[idx] ?? "";
        const mappedLine = entry.lineMap[idx] ?? idx + 1;
        const timestampMs = entry.messageTimestampsMs[idx] ?? 0;
        await client.query(
          `
          INSERT INTO session_index_chunks (
            user_id,
            workspace_id,
            file_id,
            agent_id,
            path,
            chunk_index,
            start_line,
            end_line,
            text,
            message_timestamps_ms,
            metadata
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint[], $11::jsonb)
        `,
          [
            params.userId,
            params.workspaceId,
            fileId,
            params.agentId,
            entry.path,
            idx,
            mappedLine,
            mappedLine,
            text,
            [timestampMs],
            "{}",
          ],
        );
      }

      await client.query("COMMIT");
      indexedFiles += 1;
      if (existing) {
        updatedFiles += 1;
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  let removedFiles = 0;
  if (!targetFiles) {
    const existingRows = await params.pool.query<{ path: string }>(
      `
      SELECT path
      FROM session_index_files
      WHERE user_id = $1
        AND workspace_id = $2
        AND agent_id = $3
    `,
      [params.userId, params.workspaceId, params.agentId],
    );
    for (const row of existingRows.rows) {
      const pathValue = row.path;
      if (activePaths.has(pathValue)) {
        continue;
      }
      await params.pool.query(
        `
        DELETE FROM session_index_files
        WHERE user_id = $1
          AND workspace_id = $2
          AND path = $3
      `,
        [params.userId, params.workspaceId, pathValue],
      );
      removedFiles += 1;
    }
  }

  return {
    indexedFiles,
    updatedFiles,
    skippedFiles,
    removedFiles,
  };
}
