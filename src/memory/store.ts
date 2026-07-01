import type { AnchorClawConfig } from "../config.js";
import type { PostgresPool } from "../postgres.js";
import { upsertMemoryItemEmbedding } from "../semantic/indexing.js";
import { buildSemanticEmbedding } from "../semantic/runtime.js";

// MVP: keep types aligned with the OpenClaw `MEMORY.md` role.
// Future: add explicit durable types (profile/config/skill/summary/automation) behind a clear policy.
type MemoryItemType = "fact" | "note";
type MemoryItemSource = "user" | "agent" | "migration" | "system" | "integration";

function coerceStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const strings = value.filter((item) => typeof item === "string") as string[];
  return strings.length === value.length ? strings : null;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
}

export type MemoryStoreResult =
  | {
      ok: true;
      corpus: "memory";
      path: string;
      id: string;
      updatedAt: string;
      created: boolean;
      version: number;
    }
  | {
      ok: false;
      disabled?: boolean;
      error: string;
    };

export async function memoryStoreDb(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  actor?: string;
  logger?: { warn(message: string): void };
  semantic?: {
    cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined;
    runtimeConfig: unknown;
    agentId?: string | null | undefined;
  };
  input: unknown;
}): Promise<MemoryStoreResult> {
  const raw = (params.input ?? {}) as any;
  const content = typeof raw?.content === "string" ? raw.content : "";
  if (!content.trim()) {
    return { ok: false, error: "content is required" };
  }

  const derivedTitle = (() => {
    const firstNonEmptyLine = content
      .split("\n")
      .map((line: string) => line.trim())
      .find((line: string) => Boolean(line));
    if (!firstNonEmptyLine) {
      return null;
    }
    const max = 120;
    return firstNonEmptyLine.length > max ? `${firstNonEmptyLine.slice(0, max)}…` : firstNonEmptyLine;
  })();

  const type: MemoryItemType =
    raw?.type === "fact" ||
    raw?.type === "note"
      ? raw.type
      : "note";

  const namespace = typeof raw?.namespace === "string" && raw.namespace.trim() ? raw.namespace.trim() : "default";
  const title = typeof raw?.title === "string" && raw.title.trim() ? raw.title : derivedTitle;
  const tags = coerceStringArray(raw?.tags) ?? [];
  const metadata =
    raw?.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata) ? raw.metadata : {};
  const canonicalKey =
    typeof raw?.canonicalKey === "string" && raw.canonicalKey.trim() ? raw.canonicalKey.trim() : null;

  const importance =
    typeof raw?.importance === "number" ? clampInteger(raw.importance, 0, 100) : 50;
  const confidence =
    typeof raw?.confidence === "number" ? clampInteger(raw.confidence, 0, 100) : 80;

  const source: MemoryItemSource =
    raw?.source === "user" ||
    raw?.source === "agent" ||
    raw?.source === "migration" ||
    raw?.source === "system" ||
    raw?.source === "integration"
      ? raw.source
      : "agent";

  const actor = typeof raw?.actor === "string" && raw.actor.trim() ? raw.actor : params.actor ?? "anchorclaw";

  const client = await params.pool.connect();
  try {
    await client.query("BEGIN");

    let before: any | null = null;
    if (canonicalKey) {
      const existing = await client.query(
        `
        SELECT id, type, namespace, status, source, title, content, metadata, tags, importance, confidence, version, updated_at
        FROM memory_items
        WHERE user_id = $1
          AND workspace_id = $2
          AND status = 'active'
          AND type = $3
          AND namespace = $4
          AND canonical_key = $5
        LIMIT 1
      `,
        [params.userId, params.workspaceId, type, namespace, canonicalKey],
      );
      before = existing.rows[0] ?? null;
    }

    const upserted = await client.query<{
      id: string;
      updated_at: string;
      version: number;
    }>(
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
        canonical_key,
        created_by,
        updated_by
      )
      VALUES (
        $1, $2, $3, $4, 'active', $5,
        $6, $7, $8::jsonb, $9::text[],
        $10, $11, $12,
        $13, $13
      )
      ON CONFLICT (user_id, workspace_id, namespace, type, canonical_key)
        WHERE status = 'active' AND canonical_key IS NOT NULL
      DO UPDATE SET
        title = EXCLUDED.title,
        content = EXCLUDED.content,
        metadata = EXCLUDED.metadata,
        tags = EXCLUDED.tags,
        importance = EXCLUDED.importance,
        confidence = EXCLUDED.confidence,
        source = EXCLUDED.source,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by,
        version = memory_items.version + 1
      RETURNING id, updated_at, version
    `,
      [
        params.userId,
        params.workspaceId,
        type,
        namespace,
        source,
        title,
        content,
        JSON.stringify(metadata),
        tags,
        importance,
        confidence,
        canonicalKey,
        actor,
      ],
    );
    const row = upserted.rows[0];
    if (!row) {
      throw new Error("failed to store memory item");
    }
    await client.query(
      `
      INSERT INTO memory_audit_log (user_id, item_id, operation, before, after, actor, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, now())
    `,
      [
        params.userId,
        row.id,
        before ? "update" : "insert",
        before ? JSON.stringify(before) : null,
        JSON.stringify({
          id: row.id,
          type,
          namespace,
          status: "active",
          source,
          title,
          content,
          metadata,
          tags,
          importance,
          confidence,
          canonical_key: canonicalKey,
          version: row.version,
          updated_at: row.updated_at,
        }),
        actor,
      ],
    );

    await client.query("COMMIT");
    const result: MemoryStoreResult = {
      ok: true,
      corpus: "memory",
      path: `db-memory/items/${row.id}.md`,
      id: row.id,
      updatedAt: row.updated_at,
      created: !before,
      version: row.version,
    };
    if (params.semantic?.runtimeConfig && params.semantic?.agentId) {
      try {
        const embedding = await buildSemanticEmbedding({
          cfg: params.semantic.cfg,
          runtimeConfig: params.semantic.runtimeConfig,
          agentId: params.semantic.agentId,
          text: content,
          purpose: "document",
        });
        if (embedding) {
          await upsertMemoryItemEmbedding({
            pool: params.pool,
            memoryItemId: row.id,
            profileKey: embedding.profileKey,
            vector: embedding.vector,
            memoryItemVersion: row.version,
            dimensions: embedding.dimensions,
          });
        }
      } catch (error) {
        params.logger?.warn(
          `anchorclaw: semantic write skipped for memory item ${row.id} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      params.logger?.warn(
        `anchorclaw: memory_store rollback failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
      );
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}
