import type { PostgresPool } from "../postgres.js";
import { parseDbMemoryPath } from "./paths.js";

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export type MemoryForgetResult =
  | {
      ok: true;
      corpus: "memory";
      deleted: number;
      ids: string[];
    }
  | {
      ok: false;
      disabled?: boolean;
      error: string;
    };

export async function memoryForgetDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  actor?: string;
  logger?: { warn(message: string): void };
  input: unknown;
}): Promise<MemoryForgetResult> {
  const raw = (params.input ?? {}) as any;
  const lookup = typeof raw?.lookup === "string" ? raw.lookup.trim() : "";
  const idParam = typeof raw?.id === "string" ? raw.id.trim() : "";

  const id = (() => {
    if (lookup) {
      const parsed = parseDbMemoryPath(lookup);
      if (parsed?.kind === "item") {
        return parsed.id;
      }
    }
    if (idParam && isUuidLike(idParam)) {
      return idParam;
    }
    return null;
  })();

  if (!id) {
    return { ok: false, error: "provide lookup=db-memory/items/<uuid>.md or id=<uuid>" };
  }

  const actor = typeof raw?.actor === "string" && raw.actor.trim() ? raw.actor : params.actor ?? "anchorclaw";

  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");

    const before = await client.query(
      `
      SELECT id, type, namespace, status, source, title, content, metadata, tags, importance, confidence, version, updated_at, deleted_at
      FROM memory_items
      WHERE user_id = $1 AND workspace_id = $2 AND id = $3
      LIMIT 1
    `,
      [params.userId, params.workspaceId, id],
    );
    const existing = before.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return { ok: true, corpus: "memory", deleted: 0, ids: [] };
    }

    if (existing.status === "deleted") {
      await client.query("ROLLBACK");
      return { ok: true, corpus: "memory", deleted: 0, ids: [] };
    }

    const updated = await client.query<{ id: string; updated_at: string }>(
      `
      UPDATE memory_items
      SET status = 'deleted',
          deleted_at = now(),
          updated_at = now(),
          updated_by = $4
      WHERE user_id = $1 AND workspace_id = $2 AND id = $3 AND status <> 'deleted'
      RETURNING id, updated_at
    `,
      [params.userId, params.workspaceId, id, actor],
    );
    const row = updated.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { ok: true, corpus: "memory", deleted: 0, ids: [] };
    }

    await client.query(
      `
      INSERT INTO memory_audit_log (user_id, item_id, operation, before, after, actor, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
    `,
      [
        params.userId,
        id,
        "soft_delete",
        JSON.stringify(existing),
        JSON.stringify({ ...existing, status: "deleted", deleted_at: row.updated_at, updated_at: row.updated_at }),
        actor,
      ],
    );

    await client.query("COMMIT");
    return { ok: true, corpus: "memory", deleted: 1, ids: [id] };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      params.logger?.warn(
        `anchorclaw: memory_forget rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}
