import type { AnchorClawConfig } from "./config.js";

export function getIdentityStartupWarning(cfg: AnchorClawConfig): string | null {
  if (cfg.identity?.externalId) {
    return null;
  }
  return "anchorclaw: identity.externalId is not configured; falling back to OS-user identity. This is unsafe for Docker/production and may fragment memory scopes.";
}

