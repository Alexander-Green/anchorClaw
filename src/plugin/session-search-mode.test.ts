import { describe, expect, it } from "vitest";

import {
  compareOpenClawVersions,
  resolveSessionSearchMode,
} from "./session-search-mode.js";

describe("session search compatibility mode", () => {
  it("orders OpenClaw prereleases using semver rules", () => {
    expect(compareOpenClawVersions("2026.8.1-beta.1", "2026.8.1-beta.2")).toBeLessThan(0);
    expect(compareOpenClawVersions("2026.8.1-beta.2", "2026.8.1-beta.2")).toBe(0);
    expect(compareOpenClawVersions("v2026.8.1-beta.2+build.7", "2026.8.1-beta.2")).toBe(0);
    expect(compareOpenClawVersions("2026.8.1", "2026.8.1-beta.2")).toBeGreaterThan(0);
    expect(compareOpenClawVersions("2026.8.1-beta-rc.1", "2026.8.1-beta.2")).toBeGreaterThan(0);
    expect(compareOpenClawVersions("2026.08.1", "2026.8.1")).toBeNull();
  });

  it("keeps legacy mode when the runtime version is old or unavailable", () => {
    expect(resolveSessionSearchMode({ runtime: { version: "2026.5.28" } } as any)).toBe(
      "legacy-anchorclaw",
    );
    expect(resolveSessionSearchMode({ runtime: {} } as any)).toBe("legacy-anchorclaw");
    expect(resolveSessionSearchMode({ runtime: { version: "not-semver" } } as any)).toBe(
      "legacy-anchorclaw",
    );
  });

  it("hands session search to OpenClaw from 2026.8.1-beta.1", () => {
    expect(resolveSessionSearchMode({ runtime: { version: "2026.7.1" } } as any)).toBe(
      "legacy-anchorclaw",
    );
    expect(resolveSessionSearchMode({ runtime: { version: "2026.8.1-beta.1" } } as any)).toBe(
      "native-openclaw",
    );
    expect(resolveSessionSearchMode({ runtime: { version: "2026.8.1-beta.2" } } as any)).toBe(
      "native-openclaw",
    );
    expect(resolveSessionSearchMode({ runtime: { version: "2026.8.2" } } as any)).toBe(
      "native-openclaw",
    );
  });
});
