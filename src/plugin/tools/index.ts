import { registerMemoryForgetTool } from "./memory-forget.js";
import { registerMemoryGetTool } from "./memory-get.js";
import { registerMemoryRecallTool } from "./memory-recall.js";
import { registerMemorySearchTool } from "./memory-search.js";
import { registerMemoryStatusTool } from "./memory-status.js";
import { registerMemoryStoreTool } from "./memory-store.js";
import type { ToolRegistrationParams } from "./common.js";

export function registerAnchorClawTools(params: ToolRegistrationParams) {
  registerMemorySearchTool(params);
  registerMemoryGetTool(params);
  registerMemoryStoreTool(params);
  registerMemoryRecallTool(params);
  registerMemoryForgetTool(params);
  // Keep diagnostics tool last so retrieval flows prioritize search/get/recall tools.
  registerMemoryStatusTool(params);
}
