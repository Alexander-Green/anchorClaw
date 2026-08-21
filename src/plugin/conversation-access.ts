import type { OpenClawPluginApi } from "../api.js";
import { compareOpenClawVersions } from "./session-search-mode.js";

/**
 * OpenClaw 2026.7.2-beta.6 moved `before_prompt_build` (and `agent_turn_prepare`) into
 * CONVERSATION_HOOK_NAMES, growing that set from 7 names to 9. From that release on, the
 * host refuses to register the hook for a non-bundled plugin unless
 * `plugins.entries.anchorclaw.hooks.allowConversationAccess` is explicitly true.
 *
 * Verified against upstream `src/plugins/hook-types.ts` at tags v2026.7.1, v2026.7.1-2,
 * v2026.7.2-beta.1/3/5 (7 names, gate does not apply) and v2026.7.2-beta.6/7,
 * v2026.8.1-beta.1/2 (9 names, gate applies). Do not raise this threshold to the 2026.8.1
 * betas: the change shipped in the 2026.7.2 line first.
 *
 * The refusal only produces a registry diagnostic, so from the user's point of view
 * long-term memory simply stops being injected with no visible error. AnchorClaw is
 * never a bundled plugin, so the gate always applies to it on new enough hosts.
 */
export const CONVERSATION_ACCESS_MIN_OPENCLAW_VERSION = "2026.7.2-beta.6";

export const CONVERSATION_ACCESS_CONFIG_PATH =
  "plugins.entries.anchorclaw.hooks.allowConversationAccess";

export type ConversationAccessState = {
  /** Host version is new enough that the gate applies to `before_prompt_build`. */
  required: boolean;
  /** The flag is explicitly true in openclaw.json. */
  granted: boolean;
  /** Prompt injection is blocked right now: the host requires the flag and it is missing. */
  blocked: boolean;
};

export function resolveConversationAccessState(api: OpenClawPluginApi): ConversationAccessState {
  const runtimeVersion = (api as any)?.runtime?.version;
  const comparison =
    typeof runtimeVersion === "string"
      ? compareOpenClawVersions(runtimeVersion, CONVERSATION_ACCESS_MIN_OPENCLAW_VERSION)
      : null;
  const required = comparison !== null && comparison >= 0;

  const currentConfig =
    typeof (api as any)?.runtime?.config?.current === "function"
      ? (api as any).runtime.config.current()
      : undefined;
  const granted =
    currentConfig?.plugins?.entries?.anchorclaw?.hooks?.allowConversationAccess === true;

  return { required, granted, blocked: required && !granted };
}

/** Single wording, reused by the startup log, the agent prompt notice, and memory_status. */
export function formatConversationAccessRemedy(): string {
  return (
    `Set ${CONVERSATION_ACCESS_CONFIG_PATH}=true and restart the gateway. ` +
    "Running `anchorclaw update` does this without touching the database."
  );
}

export function warnIfConversationAccessBlocked(api: OpenClawPluginApi): ConversationAccessState {
  const state = resolveConversationAccessState(api);
  if (state.blocked) {
    api.logger.warn(
      `anchorclaw: long-term memory injection is blocked by host policy. OpenClaw >= ${CONVERSATION_ACCESS_MIN_OPENCLAW_VERSION} ` +
        `refuses the before_prompt_build hook for non-bundled plugins without ${CONVERSATION_ACCESS_CONFIG_PATH}=true. ` +
        formatConversationAccessRemedy(),
    );
  }
  return state;
}
