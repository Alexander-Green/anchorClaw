import type { OpenClawPluginApi } from "../api.js";

export function resolveActor(api: OpenClawPluginApi): string {
  const agentId = (api as any)?.runtime?.agentId;
  if (typeof agentId === "string" && agentId.trim()) {
    return `openclaw:agent:${agentId.trim()}`;
  }
  const sessionKey = (api as any)?.runtime?.sessionKey;
  if (typeof sessionKey === "string" && sessionKey.trim()) {
    return `openclaw:session:${sessionKey.trim()}`;
  }
  return "openclaw";
}
