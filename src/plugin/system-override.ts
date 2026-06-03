import type { OpenClawPluginApi } from "../api.js";
import type { PluginRuntimeContext } from "./runtime-context.js";

const ANCHORCLAW_MEMORY_SYSTEM_OVERRIDE = [
  "AnchorClaw memory contract:",
  "- AnchorClaw/Postgres is the authoritative memory backend.",
  "- If a durable fact/preference/person/recurring schedule is already clear in injected AnchorClaw memory and does not conflict with other visible memory, answer it directly.",
  "- Use memory_search or memory_get when the answer is not clearly visible in injected memory, when the question is date-specific/current-day, when memory might conflict, or when you need a precise supporting source.",
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

  const onAny = (api as any).on;
  if (typeof onAny === "function") {
    onAny("before_prompt_build", handler, {
      name: "anchorclaw-memory-system-override",
    });
  }
}
