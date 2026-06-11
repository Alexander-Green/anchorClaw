import path from "node:path";

import type { OpenClawPluginApi } from "../api.js";
import { resolveUserAndWorkspaceScope } from "../identity.js";
import {
  buildPromptMemorySection,
  queryPromptMemoryItems,
} from "../memory/prompt.js";
import type { PluginRuntimeContext } from "./runtime-context.js";
import type { RuntimeWorkspaceTarget } from "./runtime-workspace.js";

// External import commands run in another process and cannot invalidate the live gateway cache.
const DEFAULT_PROMPT_CACHE_TTL_MS = 60_000;

type PromptCacheEntry = {
  generation: number;
  lines: string[] | null;
  loadedAtMs: number;
  loadPromise: Promise<string[]> | null;
};

export type PromptMemoryRuntime = {
  getPromptMemoryLines: (
    target: RuntimeWorkspaceTarget,
    options?: { force?: boolean },
  ) => Promise<string[]>;
  invalidatePromptMemory: (params: { workspaceDir: string }) => void;
};

function cacheKey(workspaceDir: string): string {
  return path.resolve(workspaceDir);
}

export function createPromptMemoryRuntime(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
  ttlMs?: number;
  now?: () => number;
}): PromptMemoryRuntime {
  const { api, ctx } = params;
  const ttlMs = Math.max(0, params.ttlMs ?? DEFAULT_PROMPT_CACHE_TTL_MS);
  const now = params.now ?? Date.now;
  const cache = new Map<string, PromptCacheEntry>();
  const generations = new Map<string, number>();

  const invalidatePromptMemory = ({ workspaceDir }: { workspaceDir: string }) => {
    const key = cacheKey(workspaceDir);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    cache.delete(key);
  };

  const getPromptMemoryLines = async (
    target: RuntimeWorkspaceTarget,
    options?: { force?: boolean },
  ): Promise<string[]> => {
    if (!ctx.cfg) {
      throw new Error(ctx.disabledReason ?? "invalid config");
    }

    const key = cacheKey(target.workspaceDir);
    const generation = generations.get(key) ?? 0;
    const existing = cache.get(key);
    if (existing?.loadPromise && existing.generation === generation) {
      return existing.loadPromise;
    }
    if (!options?.force && existing?.lines && now() - existing.loadedAtMs < ttlMs) {
      return existing.lines;
    }

    const loadPromise = (async () => {
      await ctx.ensureReady();
      const scope = await resolveUserAndWorkspaceScope({
        api,
        pool: ctx.getPool(),
        workspaceDir: target.workspaceDir,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
        configuredExternalId: ctx.cfg?.identity?.externalId,
      });
      const items = await queryPromptMemoryItems({
        pool: ctx.getPool(),
        userId: scope.userId,
        workspaceId: scope.workspaceId,
        limit: 50,
        types: ["fact", "note"],
      });
      const maxItemsByType = items.reduce<Record<string, number>>((acc, item) => {
        acc[item.type] = (acc[item.type] ?? 0) + 1;
        return acc;
      }, {});
      const lines = buildPromptMemorySection({
        items,
        maxTotalChars: 12_000,
        maxTitleChars: 120,
        policy: {
          maxItemsByType,
          defaultMaxItemChars: 2_400,
        },
      });

      if ((generations.get(key) ?? 0) === generation) {
        cache.set(key, {
          generation,
          lines,
          loadedAtMs: now(),
          loadPromise: null,
        });
      }
      return lines;
    })();

    cache.set(key, {
      generation,
      lines: existing?.lines ?? null,
      loadedAtMs: existing?.loadedAtMs ?? 0,
      loadPromise,
    });

    try {
      return await loadPromise;
    } catch (error) {
      const current = cache.get(key);
      if (current?.loadPromise === loadPromise) {
        cache.delete(key);
      }
      throw error;
    }
  };

  return {
    getPromptMemoryLines,
    invalidatePromptMemory,
  };
}
