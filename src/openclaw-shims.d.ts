// These shims make `tsc`/unit tests work in a plain Node/npm environment.
// At runtime, OpenClaw provides these modules.

declare module "openclaw/plugin-sdk/plugin-entry" {
  export type OpenClawPluginApi = any;
  export function definePluginEntry(entry: any): any;
}

declare module "openclaw/plugin-sdk/memory-core-host-runtime-core" {
  export function registerMemoryCapability(pluginId: string, capability: any): void;
}

