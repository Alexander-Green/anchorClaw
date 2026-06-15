import { createHash } from "node:crypto";

import {
  resolveMemorySearchConfig,
  resolveAgentDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { getEmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { getMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";

import {
  resolveAgentMemorySearchConfig,
  resolveSemanticLayerState,
  type AnchorClawConfig,
} from "../config.js";
import type { PostgresPool } from "../postgres.js";

type RuntimeConfigLike = Record<string, any>;

export type SemanticProviderKind = "generic" | "memory_legacy";

export type SemanticRuntimeProfile = {
  configured: boolean;
  enabled: boolean;
  effective: boolean;
  reasonCode?: "semantic_disabled" | "semantic_not_implemented";
  source?: "agent" | "defaults";
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyConfigured?: boolean;
  profileKey?: string;
  error?: string;
};

export type SemanticProbeResult = {
  checked: true;
  checkedAtMs: number;
  providerKind: SemanticProviderKind;
  providerReachable: boolean;
  dimensions?: number;
  error?: string;
};

export type SemanticSchemaState = {
  schemaReady: boolean;
  vectorExtensionInstalled: boolean;
  embeddingsTableReady: boolean;
  migrationsTableReady: boolean;
  schemaVersion: string | null;
};

type ResolvedSemanticRuntime = {
  profile: SemanticRuntimeProfile;
  resolvedMemorySearch: ReturnType<typeof resolveMemorySearchConfig> | null;
};

type InternalSemanticProvider = {
  id: string;
  model: string;
  close?: () => Promise<void> | void;
  embedQuery: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildProfileKey(resolved: NonNullable<ReturnType<typeof resolveMemorySearchConfig>>): string {
  const payload = {
    provider: resolved.provider,
    model: resolved.model,
    outputDimensionality: resolved.outputDimensionality ?? "auto",
    inputType: resolved.inputType ?? null,
    queryInputType: resolved.queryInputType ?? null,
    documentInputType: resolved.documentInputType ?? null,
    remoteBaseUrl: resolved.remote?.baseUrl ?? null,
    localModelPath: resolved.local?.modelPath ?? null,
    localModelCacheDir: resolved.local?.modelCacheDir ?? null,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function validateEmbeddingVector(params: {
  vector: unknown;
  configuredDimensions?: number;
  providerDimensions?: number;
}): number {
  if (!Array.isArray(params.vector) || params.vector.length === 0) {
    throw new Error("embedding provider returned an empty vector");
  }
  for (const value of params.vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("embedding provider returned a non-finite vector value");
    }
  }
  const dimensions = params.vector.length;
  if (
    typeof params.configuredDimensions === "number" &&
    params.configuredDimensions > 0 &&
    dimensions !== params.configuredDimensions
  ) {
    throw new Error(
      `embedding dimensions mismatch: expected ${params.configuredDimensions}, got ${dimensions}`,
    );
  }
  if (
    typeof params.providerDimensions === "number" &&
    params.providerDimensions > 0 &&
    dimensions !== params.providerDimensions
  ) {
    throw new Error(
      `embedding provider dimensions mismatch: provider advertises ${params.providerDimensions}, got ${dimensions}`,
    );
  }
  return dimensions;
}

function createProbeAbortController(timeoutMs: number): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`semantic probe timed out after ${timeoutMs}ms`)), timeoutMs);
  return {
    controller,
    dispose: () => clearTimeout(timer),
  };
}

function resolveSemanticError(params: {
  enabled: boolean;
  runtimeConfig: unknown;
  agentId?: string;
  provider?: string;
  model?: string;
  coreResolved: ReturnType<typeof resolveMemorySearchConfig> | null;
  coreError?: string;
}): string | undefined {
  if (!params.enabled) {
    return undefined;
  }
  if (!params.runtimeConfig) {
    return "runtime config unavailable; cannot resolve semantic memorySearch";
  }
  if (!params.agentId) {
    return "runtime agent id unavailable; cannot resolve semantic memorySearch";
  }
  if (params.coreError) {
    return `semantic memorySearch resolution failed (${params.coreError})`;
  }
  if (params.coreResolved === null) {
    if (params.provider || params.model) {
      return "semantic enabled but OpenClaw memorySearch is disabled for the active agent";
    }
    return "semantic enabled but memorySearch.provider/model is not configured for the active agent";
  }
  if (!params.provider || !params.model) {
    return "semantic enabled but memorySearch.provider/model is not configured for the active agent";
  }
  return undefined;
}

export function resolveSemanticRuntimeProfile(params: {
  cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined;
  runtimeConfig: unknown;
  agentId?: string | null | undefined;
}): ResolvedSemanticRuntime {
  const semanticLayer = resolveSemanticLayerState(params.cfg);
  const visible = resolveAgentMemorySearchConfig({
    runtimeConfig: params.runtimeConfig,
    agentId: params.agentId,
  });

  let coreResolved: ReturnType<typeof resolveMemorySearchConfig> | null = null;
  let coreError: string | undefined;
  const normalizedAgentId = typeof params.agentId === "string" && params.agentId.trim()
    ? params.agentId.trim()
    : undefined;
  const runtimeConfig = params.runtimeConfig as RuntimeConfigLike | undefined;

  if (semanticLayer.enabled && runtimeConfig && normalizedAgentId) {
    try {
      coreResolved = resolveMemorySearchConfig(runtimeConfig as any, normalizedAgentId);
    } catch (error) {
      coreError = errorMessage(error);
    }
  }

  const error = resolveSemanticError({
    enabled: semanticLayer.enabled,
    runtimeConfig,
    agentId: normalizedAgentId,
    provider: visible.provider,
    model: visible.model,
    coreResolved,
    coreError,
  });

  return {
    resolvedMemorySearch: coreResolved,
    profile: {
      configured: semanticLayer.configured,
      enabled: semanticLayer.enabled,
      effective: semanticLayer.effective,
      ...(semanticLayer.reason ? { reasonCode: semanticLayer.reason } : {}),
      ...(visible.source ? { source: visible.source } : {}),
      ...(visible.provider ? { provider: visible.provider } : {}),
      ...(visible.model ? { model: visible.model } : {}),
      ...(visible.baseUrl ? { baseUrl: visible.baseUrl } : {}),
      ...(visible.configured ? { apiKeyConfigured: visible.apiKeyConfigured } : {}),
      ...(coreResolved ? { profileKey: buildProfileKey(coreResolved) } : {}),
      ...(error ? { error } : {}),
    },
  };
}

async function createSemanticProvider(params: {
  runtimeConfig: RuntimeConfigLike;
  agentId: string;
  resolvedMemorySearch: NonNullable<ReturnType<typeof resolveMemorySearchConfig>>;
}): Promise<{ provider: InternalSemanticProvider; providerKind: SemanticProviderKind }> {
  const agentDir = resolveAgentDir(params.runtimeConfig as any, params.agentId);
  const settings = params.resolvedMemorySearch;

  const legacyAdapter = getMemoryEmbeddingProvider(settings.provider, params.runtimeConfig as any);
  if (legacyAdapter) {
    const result = await legacyAdapter.create({
      config: params.runtimeConfig as any,
      agentDir,
      provider: settings.provider,
      remote: settings.remote,
      model: settings.model,
      inputType: settings.inputType,
      queryInputType: settings.queryInputType,
      documentInputType: settings.documentInputType,
      fallback: "none",
      local: settings.local,
      outputDimensionality: settings.outputDimensionality,
    } as any);
    if (!result.provider) {
      throw new Error(`memory embedding provider ${settings.provider} is unavailable`);
    }
    return {
      provider: {
        id: result.provider.id,
        model: result.provider.model,
        close: result.provider.close,
        embedQuery: async (text: string, options?: { signal?: AbortSignal }) =>
          result.provider!.embedQuery(text, options),
      },
      providerKind: "memory_legacy",
    };
  }

  const genericAdapter = getEmbeddingProvider(settings.provider, params.runtimeConfig as any);
  if (!genericAdapter) {
    throw new Error(`unknown embedding provider: ${settings.provider}`);
  }
  const result = await genericAdapter.create({
    config: params.runtimeConfig as any,
    agentDir,
    provider: settings.provider,
    remote: settings.remote,
    model: settings.model,
    inputType: settings.inputType,
    queryInputType: settings.queryInputType,
    documentInputType: settings.documentInputType,
    local: settings.local,
    dimensions: settings.outputDimensionality,
  } as any);
  if (!result.provider) {
    throw new Error(`embedding provider ${settings.provider} is unavailable`);
  }
  return {
    provider: {
      id: result.provider.id,
      model: result.provider.model,
      close: result.provider.close,
      embedQuery: async (text: string, options?: { signal?: AbortSignal }) =>
        result.provider!.embed(text, {
          signal: options?.signal,
          inputType: "query",
        }),
    },
    providerKind: "generic",
  };
}

export async function probeSemanticProvider(params: {
  cfg: Pick<AnchorClawConfig, "semantic"> | null | undefined;
  runtimeConfig: unknown;
  agentId?: string | null | undefined;
  timeoutMs?: number;
}): Promise<SemanticProbeResult | null> {
  const { profile, resolvedMemorySearch } = resolveSemanticRuntimeProfile(params);
  if (!profile.enabled) {
    return null;
  }
  const checkedAtMs = Date.now();
  if (!resolvedMemorySearch || !params.runtimeConfig || !params.agentId) {
    return {
      checked: true,
      checkedAtMs,
      providerKind: "generic",
      providerReachable: false,
      ...(profile.error ? { error: profile.error } : {}),
    };
  }

  let providerKind: SemanticProviderKind = "generic";
  let provider: InternalSemanticProvider | undefined;
  try {
    const created = await createSemanticProvider({
      runtimeConfig: params.runtimeConfig as RuntimeConfigLike,
      agentId: String(params.agentId),
      resolvedMemorySearch,
    });
    providerKind = created.providerKind;
    provider = created.provider;
    const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 15_000;
    const { controller, dispose } = createProbeAbortController(timeoutMs);
    try {
      const vector = await provider.embedQuery("anchorclaw semantic probe", {
        signal: controller.signal,
      });
      const dimensions = validateEmbeddingVector({
        vector,
        configuredDimensions: resolvedMemorySearch.outputDimensionality,
      });
      return {
        checked: true,
        checkedAtMs,
        providerKind,
        providerReachable: true,
        dimensions,
      };
    } finally {
      dispose();
    }
  } catch (error) {
    return {
      checked: true,
      checkedAtMs,
      providerKind,
      providerReachable: false,
      error: errorMessage(error),
    };
  } finally {
    await provider?.close?.();
  }
}

export async function inspectSemanticSchema(params: {
  pool: PostgresPool;
}): Promise<SemanticSchemaState> {
  const rows = await params.pool.query<{
    vector_extension_installed: boolean;
    memory_item_embeddings: string | null;
    semantic_schema_migrations: string | null;
  }>(
    `SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector_extension_installed,
      to_regclass('memory_item_embeddings') AS memory_item_embeddings,
      to_regclass('semantic_schema_migrations') AS semantic_schema_migrations`,
  );
  const schema = rows.rows[0];
  const vectorExtensionInstalled = schema?.vector_extension_installed === true;
  const embeddingsTableReady = Boolean(schema?.memory_item_embeddings);
  const migrationsTableReady = Boolean(schema?.semantic_schema_migrations);

  let schemaVersion: string | null = null;
  if (migrationsTableReady) {
    const versionRows = await params.pool.query<{ id: string }>(
      "SELECT id FROM semantic_schema_migrations ORDER BY id DESC LIMIT 1",
    );
    schemaVersion = versionRows.rows[0]?.id ?? null;
  }

  return {
    schemaReady: vectorExtensionInstalled && embeddingsTableReady && migrationsTableReady,
    vectorExtensionInstalled,
    embeddingsTableReady,
    migrationsTableReady,
    schemaVersion,
  };
}
