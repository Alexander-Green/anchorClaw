import type { PostgresPool } from "../postgres.js";
import { parseDbMemoryPath } from "./paths.js";
import type { MemoryLimits } from "./limits.js";
import { buildMemoryReadResult } from "./read-file-shared.js";
import { memoryGetSessionFile } from "./sessions.js";
import { memoryGetSessionFromIndexDb, normalizeSessionLookupPath } from "./sessions-index.js";
import { syncSessionsIndexDb } from "./sessions-index-sync.js";
import fs from "node:fs/promises";
import path from "node:path";

export type MemoryGetParams = {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
};

export type MemoryGetResult =
  | {
      ok: true;
      corpus: "memory" | "sessions";
      path: string;
      title?: string;
      kind?: string;
      content: string;
      fromLine: number;
      lineCount: number;
      id?: string;
      updatedAt?: string;
    }
  | {
      ok: false;
      disabled?: boolean;
      error: string;
    };

export async function memoryGetFromDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  limits: MemoryLimits;
  lookup: string;
  agentId?: string;
  workspaceDir?: string;
  sessionsVisibility?: "off" | "current" | "visible";
  fromLine?: number;
  lineCount?: number;
}): Promise<MemoryGetResult> {
  const rawLookup = params.lookup.trim();
  if (!rawLookup) {
    return { ok: false, error: "lookup is required" };
  }

  if (rawLookup === "MEMORY.md") {
    // Treat MEMORY.md reads as a virtual snapshot generated from Postgres.
    const exported = await memoryGetFromDb({
      ...params,
      lookup: "db-memory/export/MEMORY.md",
    });
    if (!exported.ok) {
      return exported;
    }
    return {
      ...exported,
      path: "MEMORY.md",
      title: "MEMORY.md",
      kind: "export",
    };
  }

  if (rawLookup.startsWith("memory/")) {
    // Best-effort compatibility: allow reading daily memory files directly when requested.
    const workspaceDir = params.workspaceDir ? path.resolve(params.workspaceDir) : null;
    if (!workspaceDir) {
      return { ok: false, disabled: true, error: "workspaceDir unavailable for memory/* reads" };
    }
    const normalized = rawLookup.replaceAll("\\", "/");
    if (normalized.includes("..") || normalized.startsWith("/") || normalized === "memory") {
      return { ok: false, disabled: true, error: "unsupported lookup path" };
    }

    const absPath = path.resolve(workspaceDir, normalized);
    const relative = path.relative(workspaceDir, absPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return { ok: false, disabled: true, error: "unsupported lookup path" };
    }

    const fromLine = params.fromLine ?? 1;
    const lineCount = params.lineCount ?? params.limits.getDefaultLines;
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf8");
    } catch {
      return { ok: false, error: "not found" };
    }
    const read = buildMemoryReadResult({
      content,
      relPath: normalized,
      from: fromLine,
      lines: lineCount,
      defaultLines: params.limits.getDefaultLines,
      maxChars: params.limits.getMaxChars,
    });
    return {
      ok: true,
      corpus: "memory",
      path: normalized,
      kind: "daily-note",
      content: read.text,
      fromLine: read.from,
      lineCount: read.lines,
    };
  }

  if (rawLookup.startsWith("sessions/")) {
    const fromLine = params.fromLine ?? 1;
    const lineCount = params.lineCount ?? params.limits.getDefaultLines;
    const normalizedLookup = normalizeSessionLookupPath(rawLookup);
    if (!normalizedLookup) {
      return { ok: false, disabled: true, error: "unsupported sessions lookup path" };
    }
    if ((params.sessionsVisibility ?? "current") === "current") {
      const [, lookupAgentId] = normalizedLookup.split("/");
      const currentAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
      if (lookupAgentId && currentAgentId && lookupAgentId !== currentAgentId) {
        return { ok: false, disabled: true, error: "sessions lookup is restricted to current agent scope" };
      }
    }

    // Phase 1 policy: DB-first for sessions/* reads.
    const indexedRead = await memoryGetSessionFromIndexDb({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      lookup: normalizedLookup,
      fromLine,
      lineCount,
      limits: params.limits,
    });
    if (indexedRead) {
      return {
        ok: true,
        corpus: "sessions",
        path: indexedRead.path,
        kind: "session",
        content: indexedRead.text,
        fromLine: indexedRead.from,
        lineCount: indexedRead.lines,
      };
    }

    // Distinguish "index miss" (fallback allowed) from "index corruption" (fail-fast).
    const indexedFileProbe = await params.pool.query<{ id: string }>(
      `
      SELECT id
      FROM session_index_files
      WHERE user_id = $1 AND workspace_id = $2 AND path = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, normalizedLookup],
    );
    if (indexedFileProbe.rows.length > 0) {
      return {
        ok: false,
        disabled: true,
        error: `sessions index corrupted for ${normalizedLookup}; run sessions index repair and retry`,
      };
    }

    // Fallback is allowed only on index miss.
    const read = await memoryGetSessionFile({
      lookup: normalizedLookup,
      currentAgentId: params.agentId,
      fromLine,
      lineCount,
      defaultLines: params.limits.getDefaultLines,
      maxChars: params.limits.getMaxChars,
      limits: params.limits,
    });
    if (!read) {
      return { ok: false, error: "not found" };
    }
    if (params.agentId) {
      void syncSessionsIndexDb({
        pool: params.pool,
        userId: params.userId,
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        sessionFiles: [normalizedLookup],
      }).catch(() => {
        // Index repair is best-effort after file fallback.
      });
    }
    return {
      ok: true,
      corpus: "sessions",
      path: read.path,
      kind: "session",
      content: read.text,
      fromLine: read.from,
      lineCount: read.lines,
    };
  }

  const parsed = parseDbMemoryPath(params.lookup);
  if (!parsed) {
    return { ok: false, disabled: true, error: "unsupported lookup path" };
  }

  const fromLine = params.fromLine ?? 1;
  const lineCount = params.lineCount ?? params.limits.getDefaultLines;

  if (parsed.kind === "item") {
    const result = await params.pool.query<{
      id: string;
      title: string | null;
      type: string;
      content: string;
      updated_at: string;
    }>(
      `
      SELECT id, title, type, content, updated_at
      FROM memory_items
      WHERE user_id = $1 AND workspace_id = $2 AND id = $3 AND status = 'active'
      LIMIT 1
    `,
      [params.userId, params.workspaceId, parsed.id],
    );
    const row = result.rows[0];
    if (!row) {
      return { ok: false, error: "not found" };
    }
    const read = buildMemoryReadResult({
      content: row.content,
      relPath: `db-memory/items/${row.id}.md`,
      from: fromLine,
      lines: lineCount,
      defaultLines: params.limits.getDefaultLines,
      maxChars: params.limits.getMaxChars,
    });
    return {
      ok: true,
      corpus: "memory",
      path: `db-memory/items/${row.id}.md`,
      id: row.id,
      title: row.title ?? undefined,
      kind: row.type,
      content: read.text,
      fromLine: read.from,
      lineCount: read.lines,
      updatedAt: row.updated_at,
    };
  }

  if (parsed.kind === "event") {
    const result = await params.pool.query<{
      id: string;
      content: string;
      event_type: string;
      created_at: string;
    }>(
      `
      SELECT id, content, event_type, created_at
      FROM memory_events
      WHERE user_id = $1 AND workspace_id = $2 AND id = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, parsed.id],
    );
    const row = result.rows[0];
    if (!row) {
      return { ok: false, error: "not found" };
    }
    const read = buildMemoryReadResult({
      content: row.content,
      relPath: `db-memory/events/${row.id}.md`,
      from: fromLine,
      lines: lineCount,
      defaultLines: params.limits.getDefaultLines,
      maxChars: params.limits.getMaxChars,
    });
    return {
      ok: true,
      corpus: "memory",
      path: `db-memory/events/${row.id}.md`,
      id: row.id,
      kind: row.event_type,
      content: read.text,
      fromLine: read.from,
      lineCount: read.lines,
      updatedAt: row.created_at,
    };
  }

  if (parsed.kind === "export") {
    // MVP: export is generated from Postgres on demand. It is a convenience snapshot, not the runtime source of truth.
    const result = await params.pool.query<{
      id: string;
      type: string;
      status: string;
      source: string;
      title: string | null;
      content: string;
      updated_at: string;
    }>(
      `
      SELECT id, type, status, source, title, content, updated_at
      FROM memory_items
      WHERE user_id = $1 AND workspace_id = $2 AND status = 'active'
      ORDER BY importance DESC, updated_at DESC, id ASC
      LIMIT 200
    `,
      [params.userId, params.workspaceId],
    );

    const generatedAt = new Date().toISOString();
    const lines: string[] = [];
    lines.push("# MEMORY.md (AnchorClaw Export)");
    lines.push("");
    lines.push(`- Generated: ${generatedAt}`);
    lines.push(`- Scope: user=${params.userId} workspace=${params.workspaceId}`);
    lines.push("");

    if (result.rows.length === 0) {
      lines.push("_No active durable memory items._");
    } else {
      lines.push("## Durable Items");
      lines.push("");
      for (const row of result.rows) {
        const title = row.title?.trim() ? row.title.trim() : row.id;
        lines.push(`### (${row.type}) ${title}`);
        lines.push("");
        lines.push(`- id: \`${row.id}\``);
        lines.push(`- status: \`${row.status}\``);
        lines.push(`- source: \`${row.source}\``);
        lines.push(`- updated_at: \`${row.updated_at}\``);
        lines.push("");
        lines.push(row.content);
        lines.push("");
      }
    }

    const snapshot = lines.join("\n");
    const read = buildMemoryReadResult({
      content: snapshot,
      relPath: `db-memory/export/${parsed.name}`,
      from: fromLine,
      lines: lineCount,
      defaultLines: params.limits.getDefaultLines,
      maxChars: params.limits.getMaxChars,
    });

    return {
      ok: true,
      corpus: "memory",
      path: `db-memory/export/${parsed.name}`,
      title: parsed.name,
      kind: "export",
      content: read.text,
      fromLine: read.from,
      lineCount: read.lines,
      updatedAt: generatedAt,
    };
  }

  return { ok: false, disabled: true, error: "unsupported lookup kind" };
}
