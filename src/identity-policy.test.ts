import { describe, expect, it } from "vitest";
import { getIdentityStartupWarning } from "./identity-policy.js";
import type { AnchorClawConfig } from "./config.js";

function cfg(overrides?: Partial<AnchorClawConfig>): AnchorClawConfig {
  return {
    postgres: {
      host: "localhost",
      database: "anchorclaw",
      user: "postgres",
    },
    ...overrides,
  };
}

describe("getIdentityStartupWarning", () => {
  it("returns warning when identity.externalId is missing", () => {
    const got = getIdentityStartupWarning(cfg());
    expect(got).toContain("identity.externalId is not configured");
  });

  it("returns null when identity.externalId is set", () => {
    const got = getIdentityStartupWarning(cfg({ identity: { externalId: "family-main-01" } }));
    expect(got).toBeNull();
  });
});
