import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  parseCfg,
  createPool,
  scanLegacyWorkspaceMock,
  runLegacyWorkspaceImportMock,
  poolEnd,
} = vi.hoisted(() => ({
  parseCfg: vi.fn(),
  createPool: vi.fn(),
  scanLegacyWorkspaceMock: vi.fn(),
  runLegacyWorkspaceImportMock: vi.fn(),
  poolEnd: vi.fn(async () => undefined),
}));

vi.mock("../config.js", () => ({
  anchorClawConfigSchema: {
    parse: parseCfg,
  },
}));

vi.mock("../postgres.js", () => ({
  createPostgresPool: createPool,
}));

vi.mock("../importer.js", () => ({
  scanLegacyWorkspace: scanLegacyWorkspaceMock,
  runLegacyWorkspaceImport: runLegacyWorkspaceImportMock,
}));

import { runAnchorClawImport } from "./import-legacy.js";

describe("runAnchorClawImport", () => {
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const runtimeConfig = {
    agents: {
      list: [{ id: "main", default: true, workspace: "/runtime/default" }],
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();

    parseCfg.mockReturnValue({
      workspaceDir: "/cfg/workspace",
      postgres: { host: "localhost", database: "anchorclaw", user: "postgres" },
    });

    createPool.mockReturnValue({
      end: poolEnd,
    });

    scanLegacyWorkspaceMock.mockResolvedValue({
      sourceDir: "/runtime/default",
      targetWorkspaceDir: "/runtime/default",
      workspaceDir: "/runtime/default",
      memoryMd: { path: "MEMORY.md", state: "pending", sha256: "sha-memory", importedSameSha: false },
      dailyFiles: [
        {
          path: "memory/2026-06-01.md",
          logicalDate: "2026-06-01",
          sha256: "sha-daily",
          supported: true,
          importedSameSha: false,
          state: "pending",
        },
      ],
      activeLegacyCount: 2,
      pendingCount: 2,
      unsupportedCount: 0,
      unreadableCount: 0,
      hasActiveLegacy: true,
    });

    runLegacyWorkspaceImportMock.mockResolvedValue({
      scan: {},
      memoryMdResult: {
        overall: "ready",
        import: "ready",
        cleanup: "completed",
        reason: null,
        lastImportRunId: "run-1",
        lastSourceSha256: "sha-memory",
      },
      dailyImportedCount: 1,
      dailyArchivedCount: 1,
      dailySkippedImportedCount: 0,
      dailyUnsupportedCount: 0,
    });
  });

  it("prints dry-run scan output and does not apply import", async () => {
    const api = {
      pluginConfig: {},
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:test",
        config: { current: () => runtimeConfig },
      },
    } as any;

    await runAnchorClawImport(api, { defaultAgent: true });

    expect(scanLegacyWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api,
        cfg: expect.objectContaining({ workspaceDir: "/cfg/workspace" }),
        sourceDir: "/runtime/default",
        targetWorkspaceDir: "/runtime/default",
        agentId: "main",
        sessionKey: "agent:main:test",
      }),
    );
    expect(runLegacyWorkspaceImportMock).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledWith("\nAnchorClaw legacy import scan (default agent main)");
    expect(consoleLogSpy).toHaveBeenCalledWith(
      "\nNext step: run `openclaw anchorclaw import --default-agent --apply` to migrate and archive active legacy files.",
    );
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it("applies import with cleanup/archive enabled by default", async () => {
    const api = {
      pluginConfig: {},
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:test",
        config: { current: () => runtimeConfig },
      },
    } as any;

    await runAnchorClawImport(api, { defaultAgent: true, apply: true });

    expect(runLegacyWorkspaceImportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        api,
        cfg: expect.objectContaining({ workspaceDir: "/cfg/workspace" }),
        sourceDir: "/runtime/default",
        targetWorkspaceDir: "/runtime/default",
        cleanupMemoryMdAfterImport: true,
        archiveImportedFiles: true,
      }),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith("\nAnchorClaw legacy import complete (default agent main)");
    expect(consoleLogSpy).toHaveBeenCalledWith("- daily files archived: 1");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it("supports keep-files mode and warns about duplicate injection risk", async () => {
    const api = {
      pluginConfig: {},
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:test",
        config: { current: () => runtimeConfig },
      },
    } as any;

    await runAnchorClawImport(api, {
      defaultAgent: true,
      sourceDir: "./relative-workspace",
      apply: true,
      keepFiles: true,
    });

    expect(runLegacyWorkspaceImportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: expect.stringMatching(/relative-workspace$/),
        targetWorkspaceDir: "/runtime/default",
        cleanupMemoryMdAfterImport: false,
        archiveImportedFiles: false,
      }),
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Warning: --keep-files leaves legacy files active and can reintroduce duplicate prompt injection risk.",
    );
    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it("warns when dry-run skips unreadable legacy daily files", async () => {
    scanLegacyWorkspaceMock.mockResolvedValueOnce({
      sourceDir: "/runtime/default",
      targetWorkspaceDir: "/runtime/default",
      workspaceDir: "/runtime/default",
      memoryMd: { path: "MEMORY.md", state: "absent", sha256: null, importedSameSha: false },
      dailyFiles: [
        {
          path: "memory/2026-06-01.md",
          logicalDate: null,
          sha256: null,
          supported: false,
          importedSameSha: false,
          state: "unreadable",
          error: "EACCES",
        },
      ],
      activeLegacyCount: 0,
      pendingCount: 0,
      unsupportedCount: 0,
      unreadableCount: 1,
      hasActiveLegacy: false,
    } as any);
    const api = {
      pluginConfig: {},
      runtime: {
        agentId: "main",
        sessionKey: "agent:main:test",
        config: { current: () => runtimeConfig },
      },
    } as any;

    await runAnchorClawImport(api, { defaultAgent: true });

    expect(consoleLogSpy).toHaveBeenCalledWith("- unreadable daily files: 1");
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Warning: unreadable legacy daily files were skipped; fix file permissions or contents, then rerun `openclaw anchorclaw import`.",
    );
  });
});
