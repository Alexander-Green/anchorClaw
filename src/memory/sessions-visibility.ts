import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";

type HitLike = {
  path?: string;
  corpus?: string;
  source?: string;
};

type VisibilityRuntimeContext = {
  api: unknown;
  runtimeConfig?: Record<string, unknown>;
  getRuntimeConfig?: () => Record<string, unknown> | undefined;
  sessionKey?: string;
  fallbackToRuntimeSession?: boolean;
  sandboxed?: boolean;
};

function readRequesterSessionKey(params: VisibilityRuntimeContext): string | undefined {
  if (typeof params.sessionKey === "string" && params.sessionKey.trim()) {
    return params.sessionKey.trim();
  }
  if (params.fallbackToRuntimeSession === false) {
    return undefined;
  }
  const api = params.api;
  const runtime = (api as any)?.runtime;
  const value = runtime?.sessionKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRuntimeConfig(params: VisibilityRuntimeContext): Record<string, unknown> {
  if (params.runtimeConfig && typeof params.runtimeConfig === "object") {
    return params.runtimeConfig;
  }
  if (typeof params.getRuntimeConfig === "function") {
    const cfg = params.getRuntimeConfig();
    if (cfg && typeof cfg === "object") {
      return cfg;
    }
  }
  const current = (params.api as any)?.runtime?.config?.current;
  if (typeof current === "function") {
    const cfg = current();
    if (cfg && typeof cfg === "object") {
      return cfg as Record<string, unknown>;
    }
  }
  return {};
}

function readRuntimeSandboxed(params: VisibilityRuntimeContext): boolean {
  if (typeof params.sandboxed === "boolean") {
    return params.sandboxed;
  }
  return (params.api as any)?.runtime?.sandboxed === true;
}

function isSessionsHit(hit: HitLike): boolean {
  if ((hit.corpus ?? "").toLowerCase() === "sessions") {
    return true;
  }
  if ((hit.source ?? "").toLowerCase() === "sessions") {
    return true;
  }
  return typeof hit.path === "string" && hit.path.startsWith("sessions/");
}

async function createVisibilityGuard(params: VisibilityRuntimeContext): Promise<{
  requesterSessionKey?: string;
  guard?: { check: (targetSessionKey: string) => { allowed: boolean; error?: string } };
  combinedStore: Record<string, unknown>;
}> {
  const cfg = readRuntimeConfig(params);
  const requesterSessionKey = readRequesterSessionKey(params);
  const sandboxed = readRuntimeSandboxed(params);
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: cfg as any,
    sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(cfg as any);
  const guard = requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : undefined;
  const { store } = loadCombinedSessionStoreForGateway(cfg as any);
  return { requesterSessionKey, guard: guard as any, combinedStore: (store ?? {}) as Record<string, unknown> };
}

function sessionKeysForHit(params: {
  combinedStore: Record<string, unknown>;
  path: string;
}): string[] {
  const identity = extractTranscriptIdentityFromSessionsMemoryHit(params.path);
  if (!identity) {
    return [];
  }
  return resolveTranscriptStemToSessionKeys({
    store: params.combinedStore as any,
    stem: identity.stem,
    ...(identity.archived && identity.ownerAgentId
      ? { archivedOwnerAgentId: identity.ownerAgentId }
      : {}),
  });
}

export async function filterSessionHitsByVisibility<T extends HitLike>(params: {
  api: unknown;
  runtimeConfig?: Record<string, unknown>;
  getRuntimeConfig?: () => Record<string, unknown> | undefined;
  sessionKey?: string;
  fallbackToRuntimeSession?: boolean;
  sandboxed?: boolean;
  hits: T[];
}): Promise<T[]> {
  const { requesterSessionKey, guard, combinedStore } = await createVisibilityGuard(params);
  const next: T[] = [];
  for (const hit of params.hits) {
    if (!isSessionsHit(hit)) {
      next.push(hit);
      continue;
    }
    if (!requesterSessionKey || !guard || typeof hit.path !== "string") {
      continue;
    }
    const keys = sessionKeysForHit({
      combinedStore,
      path: hit.path,
    });
    if (keys.length === 0) {
      continue;
    }
    const allowed = keys.some((key) => guard.check(key).allowed);
    if (allowed) {
      next.push(hit);
    }
  }
  return next;
}

export async function canAccessSessionPathByVisibility(params: {
  api: unknown;
  runtimeConfig?: Record<string, unknown>;
  getRuntimeConfig?: () => Record<string, unknown> | undefined;
  sessionKey?: string;
  fallbackToRuntimeSession?: boolean;
  sandboxed?: boolean;
  path: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  const { requesterSessionKey, guard, combinedStore } = await createVisibilityGuard(params);
  if (!requesterSessionKey || !guard) {
    return { allowed: false, reason: "session visibility guard unavailable for current requester" };
  }
  const keys = sessionKeysForHit({
    combinedStore,
    path: params.path,
  });
  if (keys.length === 0) {
    return { allowed: false, reason: "session transcript is not mapped to known session keys" };
  }
  let denyReason: string | undefined;
  for (const key of keys) {
    const verdict = guard.check(key);
    if (verdict.allowed) {
      return { allowed: true };
    }
    denyReason = denyReason ?? verdict.error;
  }
  return { allowed: false, ...(denyReason ? { reason: denyReason } : {}) };
}
