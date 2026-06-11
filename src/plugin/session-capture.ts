import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import { appendDailyBlockTx, resolveDailyLogicalDate } from "../memory/daily.js";
import type { PostgresPool } from "../postgres.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import {
  resolveRuntimeWorkspaceResolution,
  resolveRuntimeWorkspaceResolutionFromScope,
  type RuntimeWorkspaceTarget,
} from "./runtime-workspace.js";

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

function formatTimeSlug(params: { nowMs: number; timezone?: string }): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    ...(params.timezone ? { timeZone: params.timezone } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(params.nowMs));
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}${minute}`;
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

function resolveSessionCaptureTarget(params: {
  api: OpenClawPluginApi;
  hookContext?: BeforeResetHookContext;
}): RuntimeWorkspaceTarget {
  const workspaceDir = nonEmptyString(params.hookContext?.workspaceDir);
  const agentId = nonEmptyString(params.hookContext?.agentId);
  const sessionKey = nonEmptyString(params.hookContext?.sessionKey);
  const sessionId = nonEmptyString(params.hookContext?.sessionId);
  const hasHookScope = Boolean(workspaceDir || agentId || sessionKey || sessionId);
  const resolution = hasHookScope
    ? resolveRuntimeWorkspaceResolutionFromScope({
        runtimeConfig:
          typeof (params.api as any)?.runtime?.config?.current === "function"
            ? (params.api as any).runtime.config.current()
            : undefined,
        workspaceDir,
        agentId,
        sessionKey,
        sessionId,
      })
    : resolveRuntimeWorkspaceResolution({ api: params.api });
  if (!resolution.ok) {
    throw new Error(`${resolution.error}: ${resolution.reason}`);
  }
  return resolution.target;
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

function buildSessionCaptureTargetPath(params: {
  logicalDate: string;
  nowMs: number;
  timezone?: string;
  sourceId: string;
}): string {
  const timeSlug = formatTimeSlug({ nowMs: params.nowMs, timezone: params.timezone });
  const shortId = params.sourceId.slice(0, 8);
  return `memory/${params.logicalDate}-${timeSlug}-${shortId}-session-capture.md`;
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

    const stored = await appendDailyBlockTx({
      client,
      userId: params.userId,
      workspaceId: params.workspaceId,
      logicalDate: params.logicalDate,
      path: params.targetPath,
      content: params.block,
      sourceKind: SESSION_CAPTURE_SOURCE_KIND,
      sourcePath: params.relPath,
      metadata: {
        ...params.metadata,
        sessionCapture: true,
        sessionCapturePath: params.relPath,
        sessionCaptureSha256: params.contentSha256,
      },
      actor: params.actor,
      auditOperationInsert: "daily_session_capture_insert",
      auditOperationUpdate: "daily_session_capture_update",
    });

    await client.query("COMMIT");
    return {
      status: "captured",
      relPath: params.relPath,
      targetPath: params.targetPath,
      dailyEntryId: stored.id,
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

  const workspaceTarget = resolveSessionCaptureTarget({
    api: params.api,
    hookContext: params.hookContext,
  });
  const pool = params.ctx.getPool();
  const { workspaceDir, agentId, sessionKey, sessionId } = workspaceTarget;
  const sessionFile = nonEmptyString(params.event?.sessionFile);
  const reason = nonEmptyString(params.event?.reason) ?? "unknown";
  const runtimeTimezone = resolveRuntimeTimezone(params.api);
  const capturedNowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const logicalDate = resolveDailyLogicalDate({
    nowMs: capturedNowMs,
    timezone: runtimeTimezone,
  });
  const capturedAtIso = new Date(capturedNowMs).toISOString();
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
  const targetPath = buildSessionCaptureTargetPath({
    logicalDate,
    nowMs: capturedNowMs,
    timezone: runtimeTimezone,
    sourceId,
  });
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

  const onAny = (api as any).on;
  if (typeof onAny === "function") {
    try {
      onAny("before_reset", handler, {
        name: "anchorclaw-session-capture",
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.debug?.(
        `anchorclaw: typed before_reset hook registration failed, trying legacy registerHook (${message})`,
      );
    }
  }

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
