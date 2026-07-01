import type { AnchorClawConfig } from "../config.js";
import type { PostgresPool } from "../postgres.js";
import {
  buildSemanticEmbedding,
  resolveSemanticRuntimeProfile,
  type SemanticRuntimeProfile,
} from "./runtime.js";

type Logger = {
  warn(message: string): void;
  info?(message: string): void;
};

type CandidateRow = {
  id: string;
  content: string;
  version: number | string;
};

type RequestRow = {
  user_id: string;
  workspace_id: string;
  profile_key: string;
  agent_id: string;
  attempts: number | string;
};

export type SemanticIndexingBatchResult = {
  enabled: boolean;
  profile?: SemanticRuntimeProfile;
  profileKey?: string;
  attempted: number;
  indexed: number;
  remaining: number;
  error?: string;
};

export type SemanticQueueResult = {
  queued: boolean;
  error?: string;
};

export type SemanticRequestProcessingResult = {
  processedRequests: number;
  indexed: number;
  requeued: number;
  superseded: number;
  failed: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatSemanticVectorLiteral(vector: readonly number[]): string {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("embedding vector must be a non-empty array");
  }
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("embedding vector contains a non-finite value");
    }
  }
  return `[${vector.join(",")}]`;
}

export async function upsertMemoryItemEmbedding(params: {
  pool: PostgresPool;
  memoryItemId: string;
  profileKey: string;
  vector: readonly number[];
  memoryItemVersion: number;
  dimensions: number;
}): Promise<void> {
  await params.pool.query(
    `
    INSERT INTO memory_item_embeddings (
      memory_item_id,
      profile_key,
      embedding,
      memory_item_version,
      dimensions
    )
    VALUES ($1, $2, $3::vector, $4, $5)
    ON CONFLICT (memory_item_id, profile_key)
    DO UPDATE SET
      embedding = EXCLUDED.embedding,
      memory_item_version = EXCLUDED.memory_item_version,
      dimensions = EXCLUDED.dimensions,
      updated_at = now()
    `,
    [
      params.memoryItemId,
      params.profileKey,
      formatSemanticVectorLiteral(params.vector),
      params.memoryItemVersion,
      params.dimensions,
    ],
  );
}

export async function countMissingSemanticEmbeddings(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  profileKey: string;
  expectedDimensions?: number;
}): Promise<number> {
  const result = await params.pool.query<{ count: string | number }>(
    `
    SELECT count(*) AS count
    FROM memory_items mi
    LEFT JOIN memory_item_embeddings emb
      ON emb.memory_item_id = mi.id
     AND emb.profile_key = $3
    WHERE mi.user_id = $1
      AND mi.workspace_id = $2
      AND mi.status = 'active'
      AND (
        emb.memory_item_id IS NULL
        OR emb.memory_item_version IS DISTINCT FROM mi.version
        OR ($4::integer IS NOT NULL AND emb.dimensions IS DISTINCT FROM $4::integer)
      )
    `,
    [
      params.userId,
      params.workspaceId,
      params.profileKey,
      typeof params.expectedDimensions === "number" ? params.expectedDimensions : null,
    ],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function selectMissingSemanticCandidates(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  profileKey: string;
  limit: number;
  expectedDimensions?: number;
}): Promise<CandidateRow[]> {
  const result = await params.pool.query<CandidateRow>(
    `
    SELECT mi.id, mi.content, mi.version
    FROM memory_items mi
    LEFT JOIN memory_item_embeddings emb
      ON emb.memory_item_id = mi.id
     AND emb.profile_key = $3
    WHERE mi.user_id = $1
      AND mi.workspace_id = $2
      AND mi.status = 'active'
      AND (
        emb.memory_item_id IS NULL
        OR emb.memory_item_version IS DISTINCT FROM mi.version
        OR ($4::integer IS NOT NULL AND emb.dimensions IS DISTINCT FROM $4::integer)
      )
    ORDER BY mi.updated_at DESC, mi.id ASC
    LIMIT $5
    `,
    [
      params.userId,
      params.workspaceId,
      params.profileKey,
      typeof params.expectedDimensions === "number" ? params.expectedDimensions : null,
      Math.max(1, params.limit),
    ],
  );
  return result.rows;
}

export async function indexMissingSemanticEmbeddings(params: {
  pool: PostgresPool;
  cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined;
  runtimeConfig: unknown;
  userId: string;
  workspaceId: string;
  agentId?: string | null | undefined;
  limit: number;
  expectedDimensions?: number;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<SemanticIndexingBatchResult> {
  const { profile } = resolveSemanticRuntimeProfile({
    cfg: params.cfg,
    runtimeConfig: params.runtimeConfig,
    agentId: params.agentId,
  });

  if (!profile.enabled) {
    return {
      enabled: false,
      profile,
      attempted: 0,
      indexed: 0,
      remaining: 0,
    };
  }
  if (!profile.profileKey) {
    return {
      enabled: true,
      profile,
      attempted: 0,
      indexed: 0,
      remaining: 0,
      error: profile.error ?? "semantic profile key is unavailable",
    };
  }

  const candidates = await selectMissingSemanticCandidates({
    pool: params.pool,
    userId: params.userId,
    workspaceId: params.workspaceId,
    profileKey: profile.profileKey,
    limit: params.limit,
    expectedDimensions: params.expectedDimensions,
  });

  let attempted = 0;
  let indexed = 0;
  let lastError: string | undefined;
  for (const candidate of candidates) {
    attempted += 1;
    try {
      const embedding = await buildSemanticEmbedding({
        cfg: params.cfg,
        runtimeConfig: params.runtimeConfig,
        agentId: params.agentId,
        text: candidate.content,
        purpose: "document",
        timeoutMs: params.timeoutMs,
      });
      if (!embedding) {
        break;
      }
      await upsertMemoryItemEmbedding({
        pool: params.pool,
        memoryItemId: candidate.id,
        profileKey: embedding.profileKey,
        vector: embedding.vector,
        memoryItemVersion: Number(candidate.version),
        dimensions: embedding.dimensions,
      });
      indexed += 1;
    } catch (error) {
      lastError = errorMessage(error);
      params.logger?.warn(
        `anchorclaw: semantic indexing skipped for memory item ${candidate.id} (${lastError})`,
      );
      break;
    }
  }

  let remaining = Math.max(0, candidates.length - indexed);
  try {
    remaining = await countMissingSemanticEmbeddings({
      pool: params.pool,
      userId: params.userId,
      workspaceId: params.workspaceId,
      profileKey: profile.profileKey,
      expectedDimensions: params.expectedDimensions,
    });
  } catch {
    // Keep the original indexing outcome if the optional backlog count fails.
  }

  return {
    enabled: true,
    profile,
    profileKey: profile.profileKey,
    attempted,
    indexed,
    remaining,
    ...(lastError ? { error: lastError } : {}),
  };
}

export async function enqueueSemanticIndexingRequest(params: {
  pool: PostgresPool;
  userId: string;
  workspaceId: string;
  agentId: string;
  profileKey: string;
  reason: string;
}): Promise<SemanticQueueResult> {
  try {
    await params.pool.query(
      `
      INSERT INTO semantic_indexing_requests (
        user_id,
        workspace_id,
        profile_key,
        agent_id,
        reason,
        status,
        requested_at,
        next_attempt_at,
        last_error
      )
      VALUES ($1, $2, $3, $4, $5, 'pending', now(), now(), NULL)
      ON CONFLICT (user_id, workspace_id, profile_key)
      DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        reason = EXCLUDED.reason,
        status = 'pending',
        next_attempt_at = now(),
        last_error = NULL
      `,
      [
        params.userId,
        params.workspaceId,
        params.profileKey,
        params.agentId,
        params.reason,
      ],
    );
    return { queued: true };
  } catch (error) {
    return { queued: false, error: errorMessage(error) };
  }
}

async function markSemanticRequestRetry(params: {
  pool: PostgresPool;
  row: RequestRow;
  error: string;
}): Promise<void> {
  await params.pool.query(
    `
    UPDATE semantic_indexing_requests
    SET
      status = 'pending',
      attempts = attempts + 1,
      last_attempt_at = now(),
      last_error = $4,
      next_attempt_at = now() + interval '15 minutes'
    WHERE user_id = $1
      AND workspace_id = $2
      AND profile_key = $3
    `,
    [
      params.row.user_id,
      params.row.workspace_id,
      params.row.profile_key,
      params.error,
    ],
  );
}

async function deleteSemanticRequest(params: {
  pool: PostgresPool;
  row: RequestRow;
}): Promise<void> {
  await params.pool.query(
    `
    DELETE FROM semantic_indexing_requests
    WHERE user_id = $1
      AND workspace_id = $2
      AND profile_key = $3
    `,
    [params.row.user_id, params.row.workspace_id, params.row.profile_key],
  );
}

export async function processSemanticIndexingRequests(params: {
  pool: PostgresPool;
  cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined;
  runtimeConfig: unknown;
  userId: string;
  workspaceId: string;
  requestLimit: number;
  itemBatchSize: number;
  timeoutMs?: number;
  logger?: Logger;
}): Promise<SemanticRequestProcessingResult> {
  const requestRows = await params.pool.query<RequestRow>(
    `
    SELECT user_id, workspace_id, profile_key, agent_id, attempts
    FROM semantic_indexing_requests
    WHERE user_id = $1
      AND workspace_id = $2
      AND status = 'pending'
      AND next_attempt_at <= now()
    ORDER BY requested_at ASC, profile_key ASC
    LIMIT $3
    `,
    [params.userId, params.workspaceId, Math.max(1, params.requestLimit)],
  );

  let indexed = 0;
  let requeued = 0;
  let superseded = 0;
  let failed = 0;

  for (const row of requestRows.rows) {
    const { profile } = resolveSemanticRuntimeProfile({
      cfg: params.cfg,
      runtimeConfig: params.runtimeConfig,
      agentId: row.agent_id,
    });

    if (!profile.enabled || !profile.profileKey) {
      const error = profile.error ?? "semantic profile unavailable";
      await markSemanticRequestRetry({ pool: params.pool, row, error });
      params.logger?.warn(
        `anchorclaw: semantic indexing request delayed (${error})`,
      );
      failed += 1;
      continue;
    }

    if (profile.profileKey !== row.profile_key) {
      await deleteSemanticRequest({ pool: params.pool, row });
      await enqueueSemanticIndexingRequest({
        pool: params.pool,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        profileKey: profile.profileKey,
        reason: "profile_changed",
      });
      superseded += 1;
      continue;
    }

    const batch = await indexMissingSemanticEmbeddings({
      pool: params.pool,
      cfg: params.cfg,
      runtimeConfig: params.runtimeConfig,
      userId: row.user_id,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      limit: params.itemBatchSize,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
    });
    indexed += batch.indexed;

    if (batch.error) {
      await markSemanticRequestRetry({ pool: params.pool, row, error: batch.error });
      failed += 1;
      continue;
    }

    if (batch.remaining === 0) {
      await deleteSemanticRequest({ pool: params.pool, row });
    } else {
      await params.pool.query(
        `
        UPDATE semantic_indexing_requests
        SET
          status = 'pending',
          attempts = attempts + 1,
          last_attempt_at = now(),
          last_error = NULL,
          next_attempt_at = now()
        WHERE user_id = $1
          AND workspace_id = $2
          AND profile_key = $3
        `,
        [row.user_id, row.workspace_id, row.profile_key],
      );
      requeued += 1;
    }
  }

  return {
    processedRequests: requestRows.rows.length,
    indexed,
    requeued,
    superseded,
    failed,
  };
}
