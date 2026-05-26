import type { OpenClawPluginApi } from "../api.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

const ANCHORCLAW_MEMORY_SYSTEM_OVERRIDE = [
  "AnchorClaw memory override:",
  "- Treat MEMORY.md as AnchorClaw DB durable memory; use memory_store, memory_search, and memory_get(\"MEMORY.md\") instead of workspace file edits/reads.",
  "- Treat memory/YYYY-MM-DD.md as AnchorClaw DB daily memory; use memory_log, memory_search with corpus=\"daily\", and memory_get(\"memory/YYYY-MM-DD.md\").",
  "- Do not use workspace fallback files such as HEARTBEAT.md, USER.md, or profiles as proof that AnchorClaw memory is empty.",
  "- Before answering that a remembered fact, preference, recurring schedule, person fact, or today's note is unknown, call AnchorClaw memory_search or memory_get.",
  "- Edit MEMORY.md or memory/*.md files directly only when the user explicitly asks for file editing or export.",
].join("\n");

export function registerAnchorClawSystemOverrideHook(params: {
  api: OpenClawPluginApi;
  ctx: PluginRuntimeContext;
}) {
  const { api, ctx } = params;
  const handler = async () => {
    if (ctx.disabledReason || !ctx.cfg) {
      return undefined;
    }
    return {
      prependSystemContext: ANCHORCLAW_MEMORY_SYSTEM_OVERRIDE,
    };
  };

  const registerHookAny = (api as any).registerHook;
  if (typeof registerHookAny === "function") {
    try {
      registerHookAny("before_prompt_build", handler, {
        name: "anchorclaw-memory-system-override",
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      api.logger.debug?.(`anchorclaw: named system override hook registration failed, trying legacy signature (${message})`);
    }
    registerHookAny("before_prompt_build", handler);
    return;
  }

  const onAny = (api as any).on;
  if (typeof onAny === "function") {
    onAny("before_prompt_build", handler, {
      name: "anchorclaw-memory-system-override",
    });
  }
}
