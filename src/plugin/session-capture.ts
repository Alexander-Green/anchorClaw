import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { resolveDailyLogicalDate } from "../memory/daily.js";
import type { PostgresPool } from "../postgres.js";
import { requireConfiguredWorkspaceDir } from "../workspace.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

const SESSION_CAPTURE_SOURCE_TYPE = "session-capture";
const SESSION_CAPTURE_SOURCE_KIND = "session_memory";
const SESSION_CAPTURE_ROOT = path.posix.join(".anchorclaw", "session-capture");
const SESSION_CAPTURE_MAX_MESSAGES = 15;
const SESSION_CAPTURE_MAX_MESSAGE_CHARS = 1_200;
const SESSION_CAPTURE_MAX_BLOCK_CHARS = 16_000;

type BeforeResetEvent = {
  sessionFile?: unknown;
  messages?: unknown;
  reason?: unknown;
};

type BeforeResetHookContext = {
  workspaceDir?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
};

type NormalizedSessionMessage = {
  role: string;
  content: string;
};

export type SessionCaptureResult =
  | {
      status: "captured";
      relPath: string;
      targetPath: string;
      dailyEntryId: string;
    }
  | {
      status: "already_captured";
      relPath: string;
      targetPath: string;
    }
  | {
      status: "empty" | "disabled";
    };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function stringifyMessagePart(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const part = value as Record<string, unknown>;
  const text =
    nonEmptyString(part.text) ??
    nonEmptyString(part.content) ??
    nonEmptyString(part.value);
  if (text) {
    return text;
  }
  return "";
}

function extractMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = stringifyMessagePart(part);
      if (text) {
        return text;
      }
    }
    return "";
  }
  if (value && typeof value === "object") {
    return stringifyMessagePart(value);
  }
  return "";
}

function hasInterSessionUserProvenance(message: Record<string, unknown>): boolean {
  if (message.role !== "user") {
    return false;
  }
  const provenance = message.provenance;
  if (!provenance || typeof provenance !== "object") {
    return false;
  }
  return (provenance as Record<string, unknown>).kind === "inter_session";
}

function normalizeSessionMessages(messages: unknown): NormalizedSessionMessage[] {
  if (!Array.isArray(messages)) {
    return [];
  }

  const normalized: NormalizedSessionMessage[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const message = raw as Record<string, unknown>;
    const role = nonEmptyString(message.role) ?? nonEmptyString(message.type);
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    if (hasInterSessionUserProvenance(message)) {
      continue;
    }
    const content = truncateText(extractMessageContent(message.content).trim(), SESSION_CAPTURE_MAX_MESSAGE_CHARS);
    if (!content || content.startsWith("/")) {
      continue;
    }
    normalized.push({ role, content });
  }

  return normalized.slice(-SESSION_CAPTURE_MAX_MESSAGES);
}

function resolveRuntimeTimezone(api: OpenClawPluginApi): string | undefined {
  const currentConfig =
    typeof (api as any)?.runtime?.config?.current === "function"
      ? (api as any).runtime.config.current()
      : undefined;
  return nonEmptyString((currentConfig as any)?.agents?.defaults?.userTimezone);
}

function resolveHookWorkspaceDir(params: {
  cfg: NonNullable<PluginRuntimeContext["cfg"]>;
  hookContext?: BeforeResetHookContext;
}): string {
  return nonEmptyString(params.hookContext?.workspaceDir) ?? requireConfiguredWorkspaceDir(params.cfg);
}

function buildSessionSourceId(params: {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  sessionFile?: string;
  contentSha256: string;
}): string {
  const stableInput = {
    agentId: params.agentId ?? null,
    sessionKey: params.sessionKey ?? null,
    sessionId: params.sessionId ?? null,
    sessionFile: params.sessionFile ?? null,
    fallbackContentSha256: params.sessionId || params.sessionFile || params.sessionKey ? null : params.contentSha256,
  };
  return sha256Hex(JSON.stringify(stableInput)).slice(0, 32);
}

function formatSessionCaptureBlock(params: {
  capturedAtIso: string;
  reason: string;
  sessionFile?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  messages: NormalizedSessionMessage[];
}): string {
  const lines = [
    `## Session Capture - ${params.capturedAtIso}`,
    `- Source: OpenClaw before_reset`,
    `- Reason: ${params.reason}`,
    ...(params.agentId ? [`- Agent ID: ${params.agentId}`] : []),
    ...(params.sessionKey ? [`- Session Key: ${params.sessionKey}`] : []),
    ...(params.sessionId ? [`- Session ID: ${params.sessionId}`] : []),
    ...(params.sessionFile ? [`- Session File: ${params.sessionFile}`] : []),
    "",
    "### Conversation Summary",
  ];

  for (const message of params.messages) {
    lines.push(`${message.role}: ${message.content}`);
  }

  return truncateText(lines.join("\n").replace(/\s+$/u, ""), SESSION_CAPTURE_MAX_BLOCK_CHARS);
}

async function appendSessionCaptureBlock(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  actor: string;
  logicalDate: string;
  targetPath: string;
  relPath: string;
  contentSha256: string;
  ledgerSha256: string;
  block: string;
  metadata: Record<string, unknown>;
}): Promise<SessionCaptureResult> {
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
        params.ledgerSha256,
        SESSION_CAPTURE_SOURCE_TYPE,
        JSON.stringify({
          ...params.metadata,
          contentSha256: params.contentSha256,
          targetPath: params.targetPath,
        }),
      ],
    );

    if (!insertedLedger.rows[0]?.id) {
      await client.query("COMMIT");
      return {
        status: "already_captured",
        relPath: params.relPath,
        targetPath: params.targetPath,
      };
    }

    const existing = await client.query<{
      id: string;
      content: string;
      updated_at: string;
    }>(
      `
      SELECT id, content, updated_at
      FROM memory_daily_entries
      WHERE user_id = $1
        AND workspace_id = $2
        AND path = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, params.targetPath],
    );

    const before = existing.rows[0] ?? null;
    const nextContent = before
      ? `${before.content.replace(/\s*$/u, "")}\n\n${params.block}`
      : params.block;
    const nextSha = sha256Hex(nextContent);

    const rowResult = await client.query<{ id: string; updated_at: string }>(
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
      VALUES (
        $1,
        $2,
        $3::date,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10
      )
      ON CONFLICT (user_id, workspace_id, path)
      DO UPDATE SET
        logical_date = EXCLUDED.logical_date,
        content = EXCLUDED.content,
        content_sha256 = EXCLUDED.content_sha256,
        source_kind = EXCLUDED.source_kind,
        source_path = EXCLUDED.source_path,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id, updated_at
    `,
      [
        params.userId,
        params.workspaceId,
        params.logicalDate,
        params.targetPath,
        nextContent,
        nextSha,
        SESSION_CAPTURE_SOURCE_KIND,
        params.relPath,
        JSON.stringify({
          ...params.metadata,
          sessionCapture: true,
          lastSessionCapturePath: params.relPath,
          lastSessionCaptureSha256: params.contentSha256,
        }),
        params.actor,
      ],
    );
    const row = rowResult.rows[0];
    if (!row) {
      throw new Error("failed to append session capture into memory_daily_entries");
    }

    await client.query(
      `
      INSERT INTO memory_audit_log (user_id, operation, before, after, actor, created_at)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, now())
    `,
      [
        params.userId,
        before ? "daily_session_capture_update" : "daily_session_capture_insert",
        before ? JSON.stringify(before) : null,
        JSON.stringify({
          id: row.id,
          path: params.targetPath,
          logical_date: params.logicalDate,
          source_kind: SESSION_CAPTURE_SOURCE_KIND,
          source_path: params.relPath,
          content_sha256: nextSha,
        }),
        params.actor,
      ],
    );

    await client.query("COMMIT");
    return {
      status: "captured",
      relPath: params.relPath,
      targetPath: params.targetPath,
      dailyEntryId: row.id,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback; keep the original error visible to the caller.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function captureBeforeResetSessionMemory(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  event?: BeforeResetEvent;
  hookContext?: BeforeResetHookContext;
  nowMs?: number;
}): Promise<SessionCaptureResult> {
  if (params.ctx.disabledReason || !params.ctx.cfg) {
    return { status: "disabled" };
  }

  const messages = normalizeSessionMessages(params.event?.messages);
  if (messages.length === 0) {
    return { status: "empty" };
  }

  await params.ctx.ensureReady();

  const workspaceDir = resolveHookWorkspaceDir({
    cfg: params.ctx.cfg,
    hookContext: params.hookContext,
  });
  const pool = params.ctx.getPool();
  const agentId = nonEmptyString(params.hookContext?.agentId) ?? nonEmptyString((params.api as any)?.runtime?.agentId);
  const sessionKey =
    nonEmptyString(params.hookContext?.sessionKey) ?? nonEmptyString((params.api as any)?.runtime?.sessionKey);
  const sessionId = nonEmptyString(params.hookContext?.sessionId);
  const sessionFile = nonEmptyString(params.event?.sessionFile);
  const reason = nonEmptyString(params.event?.reason) ?? "unknown";
  const logicalDate = resolveDailyLogicalDate({
    nowMs: params.nowMs,
    timezone: resolveRuntimeTimezone(params.api),
  });
  const capturedAtIso = new Date(Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now()).toISOString();
  const block = formatSessionCaptureBlock({
    capturedAtIso,
    reason,
    sessionFile,
    sessionId,
    sessionKey,
    agentId,
    messages,
  });
  const contentSha256 = sha256Hex(block);
  const sourceId = buildSessionSourceId({
    agentId,
    sessionKey,
    sessionId,
    sessionFile,
    contentSha256,
  });
  const relPath = path.posix.join(SESSION_CAPTURE_ROOT, logicalDate, `${sourceId}.md`);
  const targetPath = `memory/${logicalDate}.md`;
  const ledgerSha256 = sha256Hex(`anchorclaw-session-capture:v1:${relPath}`);
  const scope = await resolveUserAndWorkspaceScope({
    api: params.api,
    pool,
    workspaceDir,
    agentId,
    sessionKey,
    configuredExternalId: params.ctx.cfg.identity?.externalId,
  });

  return appendSessionCaptureBlock({
    pool,
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    actor: params.ctx.resolveActor(),
    logicalDate,
    targetPath,
    relPath,
    contentSha256,
    ledgerSha256,
    block,
    metadata: {
      source_kind: SESSION_CAPTURE_SOURCE_KIND,
      logical_date: logicalDate,
      reason,
      agentId,
      sessionKey,
      sessionId,
      sessionFile,
      capturedAt: capturedAtIso,
    },
  });
}

export function registerAnchorClawSessionCaptureHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}) {
  const { api, ctx } = params;
  const handler = async (event: BeforeResetEvent, hookContext?: BeforeResetHookContext) => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }
    try {
      const result = await captureBeforeResetSessionMemory({
        api,
        ctx,
        event,
        hookContext,
      });
      if (result.status === "captured") {
        api.logger.info(
          `anchorclaw: captured /new|/reset session memory into ${result.targetPath}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.warn(`anchorclaw: session capture failed (${message})`);
    }
    return undefined;
  };

  const registerHookAny = (api as any).registerHook;
  if (typeof registerHookAny !== "function") {
    return;
  }
  try {
    registerHookAny("before_reset", handler, {
      name: "anchorclaw-session-capture",
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    api.logger.debug?.(`anchorclaw: named session capture hook registration failed, trying legacy signature (${message})`);
  }
  registerHookAny("before_reset", handler);
}
