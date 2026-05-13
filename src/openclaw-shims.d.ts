// These shims make `tsc`/unit tests work in a plain Node/npm environment.
// At runtime, OpenClaw provides these modules.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = any;
  export function definePluginEntry(entry: any): any;
}

declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  export function registerMemoryCapability(pluginId: string, capability: any): void;
}

declare module "openclaw/plugin-sdk/memory-core-host-engine-qmd" {
  export type SessionFileEntry = {
    path: string;
    absPath: string;
    mtimeMs: number;
    size: number;
    hash: string;
    content: string;
    lineMap: number[];
    messageTimestampsMs: number[];
    generatedByDreamingNarrative?: boolean;
    generatedByCronRun?: boolean;
  };

  export function listSessionFilesForAgent(agentId: string): Promise<string[]>;
  export function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null>;
  export function sessionPathForFile(absPath: string): string;
}
