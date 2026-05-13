import { createHash } from "node:crypto";
import path from "node:path";
import type { OpenClawPluginApi } from "./api.js";
import type { PostgresPool } from "./postgres.js";

export type ResolvedScope = {
  userId: string;
  workspaceId: string;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeOsUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveIdentityBinding(params: {
  configuredExternalId?: string;
  usernameEnv?: string;
}): { channel: string; externalId: string; displayLabel: string } {
  const configuredExternalId = params.configuredExternalId?.trim();
  const username = normalizeOsUsername(params.usernameEnv ?? process.env.USERNAME ?? process.env.USER ?? "unknown");
  if (configuredExternalId) {
    return {
      channel: "anchorclaw-config",
      externalId: configuredExternalId,
      displayLabel: `configured:${configuredExternalId}`,
    };
  }
  return {
    channel: "openclaw-cli",
    externalId: sha256Hex(username),
    displayLabel: username,
  };
}

export async function resolveUserAndWorkspaceScope(params: {
  api: OpenClawPluginApi;
  pool: PostgresPool;
  agentId?: string;
  sessionKey?: string;
  configuredExternalId?: string;
}): Promise<ResolvedScope> {
  const identity = resolveIdentityBinding({ configuredExternalId: params.configuredExternalId });

  const userId = await resolveOrCreateUserId(params.pool, params.api.logger, {
    channel: identity.channel,
    externalId: identity.externalId,
    displayLabel: identity.displayLabel,
  });
  const workspaceId = await resolveOrCreateWorkspaceId(params.pool, {
    userId,
    name: resolveWorkspaceName(params.api),
    metadata: {
      agent_id: params.agentId,
      session_key: params.sessionKey,
      workspace_dir_hash: sha256Hex(resolveWorkspaceDir(params.api)),
    },
  });

  return { userId, workspaceId };
}

function resolveWorkspaceDir(api: OpenClawPluginApi): string {
  // Best-effort: fall back to CWD if the plugin runtime doesn't expose workspaceDir.
  const candidate = (api as any)?.runtime?.workspaceDir;
  if (typeof candidate === "string" && candidate.trim()) {
    return path.resolve(candidate);
  }
  return path.resolve(process.cwd());
}

function resolveWorkspaceName(api: OpenClawPluginApi): string {
  const dir = resolveWorkspaceDir(api);
  return `dir:${sha256Hex(dir)}`;
}

async function resolveOrCreateUserId(
  pool: PostgresPool,
  logger: { warn(message: string): void },
  params: { channel: string; externalId: string; displayLabel?: string },
): Promise<string> {
  const displayLabel = params.displayLabel ?? null;
  const existing = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM user_identities WHERE channel = $1 AND external_id = $2 LIMIT 1`,
    [params.channel, params.externalId],
  );
  if (existing.rows[0]?.user_id) {
    return existing.rows[0].user_id;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const createdUser = await client.query<{ id: string }>(
      `INSERT INTO users (display_name) VALUES ($1) RETURNING id`,
      [displayLabel],
    );
    const createdUserId = createdUser.rows[0]!.id;

    const inserted = await client.query<{ user_id: string }>(
      `
      INSERT INTO user_identities (user_id, channel, external_id, display_label)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel, external_id) DO NOTHING
      RETURNING user_id
    `,
      [createdUserId, params.channel, params.externalId, displayLabel],
    );

    if (inserted.rows[0]?.user_id) {
      await client.query("COMMIT");
      return inserted.rows[0].user_id;
    }

    // Race: someone inserted the identity first. Roll back and use the winner.
    await client.query("ROLLBACK");
    const retry = await client.query<{ user_id: string }>(
      `SELECT user_id FROM user_identities WHERE channel = $1 AND external_id = $2 LIMIT 1`,
      [params.channel, params.externalId],
    );
    const winner = retry.rows[0]?.user_id;
    if (!winner) {
      throw new Error("failed to resolve user id after conflict");
    }
    return winner;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.warn(
        `anchorclaw: resolveOrCreateUserId rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    throw error;
  } finally {
    client.release();
  }
}

async function resolveOrCreateWorkspaceId(
  pool: PostgresPool,
  params: { userId: string; name: string; metadata: Record<string, unknown> },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `
    INSERT INTO workspaces (user_id, name, is_default, metadata)
    VALUES ($1, $2, false, $3::jsonb)
    ON CONFLICT (user_id, name) DO UPDATE
      SET metadata = workspaces.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING id
  `,
    [params.userId, params.name, JSON.stringify(params.metadata)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("failed to resolve workspace id");
  }
  return row.id;
}
