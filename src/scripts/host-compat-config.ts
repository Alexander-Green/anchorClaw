import { asRecord } from "./openclaw-config-file.js";

/**
 * Settings in openclaw.json that AnchorClaw needs the host to have, independent of
 * database provisioning. Kept in one place so that `anchorclaw setup` (new installs)
 * and `anchorclaw update` (existing installs after an upgrade) cannot drift apart.
 */
export type HostCompatChange = {
  path: string;
  from: unknown;
  to: unknown;
  reason: string;
};

/**
 * Reconciles host-side compatibility settings in place and reports what changed.
 *
 * `allowConversationAccess` matters from OpenClaw 2026.7.2-beta.6 onwards: that release
 * moved `before_prompt_build` into CONVERSATION_HOOK_NAMES, so the host refuses to
 * register the hook for non-bundled plugins unless the flag is explicitly true. The
 * refusal is silent for the end user, and memory injection stops. Older hosts ignore
 * the flag, so setting it unconditionally is safe in both directions.
 */
export function reconcileHostCompatConfig(cfg: Record<string, any>): HostCompatChange[] {
  const changes: HostCompatChange[] = [];

  const plugins = asRecord(cfg.plugins);
  cfg.plugins = plugins;
  const entries = asRecord(plugins.entries);
  plugins.entries = entries;
  const anchorclaw = asRecord(entries.anchorclaw);
  entries.anchorclaw = anchorclaw;
  const hooks = asRecord(anchorclaw.hooks);
  anchorclaw.hooks = hooks;

  if (hooks.allowPromptInjection !== true) {
    changes.push({
      path: "plugins.entries.anchorclaw.hooks.allowPromptInjection",
      from: hooks.allowPromptInjection,
      to: true,
      reason: "required for DB-backed daily startup injection",
    });
    hooks.allowPromptInjection = true;
  }

  if (hooks.allowConversationAccess !== true) {
    changes.push({
      path: "plugins.entries.anchorclaw.hooks.allowConversationAccess",
      from: hooks.allowConversationAccess,
      to: true,
      reason:
        "OpenClaw >= 2026.7.2-beta.6 silently blocks the before_prompt_build hook for non-bundled plugins without it",
    });
    hooks.allowConversationAccess = true;
  }

  const cfgHooks = asRecord(cfg.hooks);
  cfg.hooks = cfgHooks;
  const internalHooks = asRecord(cfgHooks.internal);
  cfgHooks.internal = internalHooks;
  const internalEntries = asRecord(internalHooks.entries);
  internalHooks.entries = internalEntries;
  const sessionMemoryEntry = asRecord(internalEntries["session-memory"]);

  if (sessionMemoryEntry.enabled !== false) {
    changes.push({
      path: "hooks.internal.entries.session-memory.enabled",
      from: sessionMemoryEntry.enabled,
      to: false,
      reason: "AnchorClaw owns daily capture for /new and /reset; the bundled hook would duplicate it",
    });
  }
  internalEntries["session-memory"] = { ...sessionMemoryEntry, enabled: false };

  return changes;
}
