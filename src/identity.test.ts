import { describe, expect, it } from "vitest";
import { resolveIdentityBinding } from "./identity.js";

describe("resolveIdentityBinding", () => {
  it("uses configured externalId with anchorclaw-config channel", () => {
    const got = resolveIdentityBinding({
      configuredExternalId: "family-main-01",
      usernameEnv: "root",
    });
    expect(got).toEqual({
      channel: "anchorclaw-config",
      externalId: "family-main-01",
      displayLabel: "configured:family-main-01",
    });
  });

  it("falls back to openclaw-cli + username hash when externalId is absent", () => {
    const got = resolveIdentityBinding({ usernameEnv: "Root" });
    expect(got.channel).toBe("openclaw-cli");
    expect(got.displayLabel).toBe("root");
    expect(got.externalId).toHaveLength(64);
  });
});

