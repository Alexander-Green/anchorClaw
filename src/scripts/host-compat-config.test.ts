import { describe, expect, it } from "vitest";

import { reconcileHostCompatConfig } from "./host-compat-config.js";

describe("host compat config reconciliation", () => {
  it("fills in every required setting on a bare config", () => {
    const cfg: Record<string, any> = {};
    const changes = reconcileHostCompatConfig(cfg);

    expect(cfg.plugins.entries.anchorclaw.hooks).toEqual({
      allowPromptInjection: true,
      allowConversationAccess: true,
    });
    expect(cfg.hooks.internal.entries["session-memory"].enabled).toBe(false);
    expect(changes.map((change) => change.path)).toEqual([
      "plugins.entries.anchorclaw.hooks.allowPromptInjection",
      "plugins.entries.anchorclaw.hooks.allowConversationAccess",
      "hooks.internal.entries.session-memory.enabled",
    ]);
  });

  it("is idempotent: a second pass reports no changes", () => {
    const cfg: Record<string, any> = {};
    reconcileHostCompatConfig(cfg);
    expect(reconcileHostCompatConfig(cfg)).toEqual([]);
  });

  it("reports only the settings that actually differ", () => {
    const cfg: Record<string, any> = {
      plugins: { entries: { anchorclaw: { hooks: { allowPromptInjection: true } } } },
      hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
    };
    const changes = reconcileHostCompatConfig(cfg);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).toBe("plugins.entries.anchorclaw.hooks.allowConversationAccess");
    expect(changes[0]!.from).toBeUndefined();
    expect(changes[0]!.to).toBe(true);
  });

  it("overrides an explicit false and preserves unrelated keys", () => {
    const cfg: Record<string, any> = {
      plugins: {
        entries: {
          anchorclaw: {
            enabled: true,
            config: { postgres: { host: "db.internal" } },
            hooks: { allowConversationAccess: false },
          },
          other: { enabled: true },
        },
      },
      hooks: { internal: { entries: { "session-memory": { enabled: true, extra: 1 } } } },
    };
    reconcileHostCompatConfig(cfg);

    expect(cfg.plugins.entries.anchorclaw.hooks.allowConversationAccess).toBe(true);
    expect(cfg.plugins.entries.anchorclaw.config.postgres.host).toBe("db.internal");
    expect(cfg.plugins.entries.anchorclaw.enabled).toBe(true);
    expect(cfg.plugins.entries.other).toEqual({ enabled: true });
    expect(cfg.hooks.internal.entries["session-memory"]).toEqual({ enabled: false, extra: 1 });
  });
});
