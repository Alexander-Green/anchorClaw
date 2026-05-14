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

function readRequesterSessionKey(api: unknown): string | undefined {
  const runtime = (api as any)?.runtime;
  const value = runtime?.sessionKey;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRuntimeConfig(api: unknown): Record<string, unknown> {
  const current = (api as any)?.runtime?.config?.current;
  if (typeof current === "function") {
    const cfg = current();
    if (cfg && typeof cfg === "object") {
      return cfg as Record<string, unknown>;
    }
  }
  return {};
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

async function createVisibilityGuard(api: unknown): Promise<{
  requesterSessionKey?: string;
  guard?: { check: (targetSessionKey: string) => { allowed: boolean; error?: string } };
  combinedStore: Record<string, unknown>;
}> {
  const cfg = readRuntimeConfig(api);
  const requesterSessionKey = readRequesterSessionKey(api);
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: cfg as any,
    sandboxed: false,
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
  hits: T[];
}): Promise<T[]> {
  const { requesterSessionKey, guard, combinedStore } = await createVisibilityGuard(params.api);
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
  path: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  const { requesterSessionKey, guard, combinedStore } = await createVisibilityGuard(params.api);
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
