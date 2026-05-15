import type { PluginRuntimeContext } from "../runtime-context.js";

export type ToolRegistrationParams = {
  ctx: PluginRuntimeContext;
  refreshPromptCache: () => void;
  ensureSessionsIndexBootstrapped: () => Promise<void>;
};
