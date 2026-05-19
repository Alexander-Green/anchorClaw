import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveIdentityBinding, resolveUserAndWorkspaceScope } from "./identity.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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

describe("resolveUserAndWorkspaceScope", () => {
  it("derives workspace identity from configured workspaceDir", async () => {
    const workspaceDir = path.resolve("/configured/workspace");
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ user_id: "u1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "w1" }] });

    const scope = await resolveUserAndWorkspaceScope({
      api: { logger: { warn: vi.fn() } } as any,
      pool: { query } as any,
      workspaceDir,
      configuredExternalId: "test-owner",
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    expect(scope).toEqual({ userId: "u1", workspaceId: "w1" });
    const workspaceInsertValues = query.mock.calls[1][1];
    expect(workspaceInsertValues[1]).toBe(`dir:${sha256Hex(workspaceDir)}`);
    expect(JSON.parse(String(workspaceInsertValues[2]))).toMatchObject({
      agent_id: "main",
      session_key: "agent:main:main",
      workspace_dir_hash: sha256Hex(workspaceDir),
    });
  });
});

