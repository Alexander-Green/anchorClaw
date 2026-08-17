// These shims make `tsc`/unit tests work in a plain Node/npm environment.
// At runtime, OpenClaw provides these modules.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = any;
  export function definePluginEntry(entry: any): any;
}

declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  export function registerMemoryCapability(pluginId: string, capability: any): void;
}

declare module "openclaw/plugin-sdk/session-transcript-hit" {
  export type SessionTranscriptHitIdentity = {
    stem: string;
    ownerAgentId?: string;
    archived: boolean;
  };

  export function extractTranscriptIdentityFromSessionsMemoryHit(
    hitPath: string,
  ): SessionTranscriptHitIdentity | null;
  export function loadCombinedSessionStoreForGateway(cfg: any): { store: Record<string, unknown> };
  export function resolveTranscriptStemToSessionKeys(params: {
    store: Record<string, unknown>;
    stem: string;
    archivedOwnerAgentId?: string;
  }): string[];
}

declare module "openclaw/plugin-sdk/session-visibility" {
  export function resolveEffectiveSessionToolsVisibility(params: {
    cfg: any;
    sandboxed: boolean;
  }): string;
  export function createAgentToAgentPolicy(cfg: any): any;
  export function createSessionVisibilityGuard(params: {
    action: "history" | "send" | "status" | "list";
    requesterSessionKey: string;
    visibility: string;
    a2aPolicy: any;
  }): Promise<{ check: (targetSessionKey: string) => { allowed: boolean; error?: string } }>;
}
