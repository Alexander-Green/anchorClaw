import type { AnchorClawConfig } from "../config.js";

export type MemoryLimits = {
  maxResults: number;
  getMaxChars: number;
  getDefaultLines: number;
  sessionsMaxFileBytes: number;
  sessionsWrapChars: number;
};

const DEFAULT_LIMITS: MemoryLimits = {
  maxResults: 10,
  getMaxChars: 12_000,
  getDefaultLines: 120,
  sessionsMaxFileBytes: 2_000_000,
  sessionsWrapChars: 800,
};

export function resolveMemoryLimits(cfg: AnchorClawConfig): MemoryLimits {
  const overrides = cfg.limits;
  return {
    maxResults: overrides?.maxResults ?? DEFAULT_LIMITS.maxResults,
    getMaxChars: overrides?.getMaxChars ?? DEFAULT_LIMITS.getMaxChars,
    getDefaultLines: overrides?.getDefaultLines ?? DEFAULT_LIMITS.getDefaultLines,
    sessionsMaxFileBytes: DEFAULT_LIMITS.sessionsMaxFileBytes,
    sessionsWrapChars: DEFAULT_LIMITS.sessionsWrapChars,
  };
}
