import { registerMemoryForgetTool } from "./memory-forget.js";
import { registerMemoryGetTool } from "./memory-get.js";
import { registerMemoryLogTool } from "./memory-log.js";
import { registerMemorySearchTool } from "./memory-search.js";
import { registerMemoryStatusTool } from "./memory-status.js";
import { registerMemoryStoreTool } from "./memory-store.js";
import type { ToolRegistrationParams } from "./common.js";

export function registerAnchorClawTools(params: ToolRegistrationParams) {
  registerMemorySearchTool(params);
  registerMemoryGetTool(params);
  registerMemoryLogTool(params);
  registerMemoryStoreTool(params);
  registerMemoryForgetTool(params);
  // Keep diagnostics tool last so retrieval flows prioritize search/get tools.
  registerMemoryStatusTool(params);
}
