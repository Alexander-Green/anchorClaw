import type { OpenClawPluginApi } from "../api.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

const ANCHORCLAW_MEMORY_SYSTEM_OVERRIDE = [
  "AnchorClaw memory contract:",
  "- AnchorClaw/Postgres is the authoritative memory backend.",
  "- Do not answer remembered facts/preferences/people/recurring schedules/todos, or say they are unknown, until memory_search or memory_get has run.",
  "- If memory_search returns a direct durable fact hit, answer with it plainly; ask for confirmation only when results conflict or remain ambiguous.",
  "- For today/current-day questions, check AnchorClaw daily memory first; HEARTBEAT.md, USER.md, and profiles are not memory fallback proof unless the user asks for files/calendar.",
  "- Daily memory answers date-specific questions; only durable memory implies recurring facts.",
  "- Save requests require one successful write tool before final text: memory_store for durable facts/preferences/recurring schedules; memory_log for today/current events.",
  "- MEMORY.md and memory/YYYY-MM-DD.md are DB-backed concepts; edit those files only for explicit file edit/export requests.",
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
