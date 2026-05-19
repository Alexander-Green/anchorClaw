import { beforeEach, describe, expect, it, vi } from "vitest";

const readlineState = vi.hoisted(() => ({
  answers: [] as string[],
}));

vi.mock("pg", () => ({
  Client: class MockClient {
    async connect() {
      return undefined;
    }
    async query() {
      return { rowCount: 0, rows: [] };
    }
    async end() {
      return undefined;
    }
  },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => readlineState.answers.shift() ?? ""),
    close: vi.fn(),
  })),
}));

describe("runAnchorClawSetup workspaceDir contract", () => {
  beforeEach(() => {
    vi.resetModules();
    readlineState.answers = [];
  });

  it("fails before config update when workspaceDir cannot be resolved", async () => {
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
    const previousProfile = process.env.OPENCLAW_PROFILE;

    try {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_WORKSPACE_DIR;
      delete process.env.OPENCLAW_PROFILE;

      vi.doMock("node:os", () => ({
        homedir: () => "",
      }));

      const { runAnchorClawSetup } = await import("./setup-db.js");

      await expect(
        runAnchorClawSetup({
          nonInteractive: true,
          adminUrl: "postgres://localhost/postgres",
          dbName: "anchorclaw",
          dbUser: "anchorclaw",
          dbPassword: "secret",
          schema: "memory",
        }),
      ).rejects.toThrow(
        "workspaceDir could not be resolved for config update; pass --workspace-dir, set OPENCLAW_WORKSPACE_DIR, or use --skip-config",
      );
    } finally {
      vi.doUnmock("node:os");
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousWorkspace === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previousWorkspace;
      }
      if (previousProfile === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = previousProfile;
      }
    }
  });
});
