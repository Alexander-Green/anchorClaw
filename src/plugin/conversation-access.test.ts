import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_ACCESS_MIN_OPENCLAW_VERSION,
  resolveConversationAccessState,
  warnIfConversationAccessBlocked,
} from "./conversation-access.js";

function makeApi(params: { version?: string; allowConversationAccess?: unknown }) {
  const hooks =
    params.allowConversationAccess === undefined
      ? {}
      : { allowConversationAccess: params.allowConversationAccess };
  return {
    logger: { warn: vi.fn(), info: vi.fn() },
    runtime: {
      ...(params.version === undefined ? {} : { version: params.version }),
      config: {
        current: () => ({ plugins: { entries: { anchorclaw: { hooks } } } }),
      },
    },
  } as any;
}

describe("conversation access gate detection", () => {
  it("pins the threshold to the release that actually changed CONVERSATION_HOOK_NAMES", () => {
    // Verified against upstream src/plugins/hook-types.ts at these tags.
    // The change shipped in the 2026.7.2 line, not in the 2026.8.1 betas.
    expect(CONVERSATION_ACCESS_MIN_OPENCLAW_VERSION).toBe("2026.7.2-beta.6");
  });

  it("treats the gate as inactive on every host that still has 7 conversation hooks", () => {
    for (const version of [
      "2026.5.28",
      "2026.6.2",
      "2026.7.1",
      "2026.7.1-2", // npm dist-tag `latest` as of 2026-08-21
      "2026.7.2-beta.1",
      "2026.7.2-beta.3",
      "2026.7.2-beta.5",
    ]) {
      expect(resolveConversationAccessState(makeApi({ version }))).toEqual({
        required: false,
        granted: false,
        blocked: false,
      });
    }
  });

  it("reports a block from the threshold version onwards when the flag is missing", () => {
    for (const version of [
      "2026.7.2-beta.6",
      "2026.7.2-beta.7",
      "2026.7.2",
      "2026.8.1-beta.1",
      "2026.8.1-beta.2",
      "2026.9.0",
    ]) {
      expect(resolveConversationAccessState(makeApi({ version })).blocked).toBe(true);
    }
  });

  it("clears the block only for an explicit true", () => {
    const version = "2026.8.1-beta.2";
    expect(
      resolveConversationAccessState(makeApi({ version, allowConversationAccess: true })).blocked,
    ).toBe(false);
    expect(
      resolveConversationAccessState(makeApi({ version, allowConversationAccess: false })).blocked,
    ).toBe(true);
    expect(
      resolveConversationAccessState(makeApi({ version, allowConversationAccess: "true" })).blocked,
    ).toBe(true);
  });

  it("stays silent when the runtime version is missing or unparseable", () => {
    expect(resolveConversationAccessState(makeApi({})).blocked).toBe(false);
    expect(resolveConversationAccessState(makeApi({ version: "not-semver" })).blocked).toBe(false);
  });

  it("logs an actionable warning only while blocked", () => {
    const blockedApi = makeApi({ version: "2026.8.1-beta.2" });
    warnIfConversationAccessBlocked(blockedApi);
    expect(blockedApi.logger.warn).toHaveBeenCalledTimes(1);
    const message = blockedApi.logger.warn.mock.calls[0][0] as string;
    expect(message).toContain("plugins.entries.anchorclaw.hooks.allowConversationAccess");
    expect(message).toContain("anchorclaw update");

    const okApi = makeApi({ version: "2026.8.1-beta.2", allowConversationAccess: true });
    warnIfConversationAccessBlocked(okApi);
    expect(okApi.logger.warn).not.toHaveBeenCalled();
  });
});
