import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveScopeMock, readdirMock, readFileMock, unlinkMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(),
  readdirMock: vi.fn(),
  readFileMock: vi.fn(),
  unlinkMock: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: readdirMock,
    readFile: readFileMock,
    unlink: unlinkMock,
  },
  readdir: readdirMock,
  readFile: readFileMock,
  unlink: unlinkMock,
}));

import { createFlushInboxPlanResolver, drainFlushInbox } from "./flush-inbox.js";

function fileDirent(name: string) {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
  };
}

function dirDirent(name: string) {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
  };
}

describe("flush inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds a controlled inbox path for compaction flush", () => {
    const resolver = createFlushInboxPlanResolver({ timezone: "Asia/Almaty" });
    const plan = resolver({ nowMs: Date.parse("2026-06-02T10:11:12.345Z") });
    const secondPlan = resolver({ nowMs: Date.parse("2026-06-02T10:11:12.345Z") });

    expect(plan.relativePath).toContain(".anchorclaw/flush-inbox/2026-06-02/");
    expect(plan.relativePath).toMatch(
      /^\.anchorclaw\/flush-inbox\/2026-06-02\/flush-2026-06-02T10-11-12-345Z-[0-9a-f-]{36}\.md$/u,
    );
    expect(secondPlan.relativePath).not.toBe(plan.relativePath);
    expect(plan.systemPrompt).toContain("append-only write");
  });

  it("drains a flush inbox file into memory_daily_entries and deletes it after success", async () => {
    readdirMock
      .mockResolvedValueOnce([dirDirent("2026-06-02")])
      .mockResolvedValueOnce([fileDirent("flush-2026-06-02T10-11-12-345Z.md")]);
    readFileMock.mockResolvedValueOnce("Important session context");
    unlinkMock.mockResolvedValueOnce(undefined);
    resolveScopeMock.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
    });

    const clientQuery = vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("INSERT INTO memory_import_files")) {
        return { rows: [{ id: "ledger-1" }] };
      }
      if (text.includes("INSERT INTO memory_daily_entries")) {
        return {
          rows: [{
            id: "daily-1",
            content: "Important session context",
            content_sha256: "daily-sha",
            source_kind: "compaction_flush",
            updated_at: "2026-06-02T10:12:00.000Z",
          }],
        };
      }
      if (text.includes("max(block_index)")) {
        return { rows: [{ block_index: 0 }] };
      }
      if (text.includes("INSERT INTO memory_daily_blocks")) {
        return { rows: [{ id: "block-1" }] };
      }
      if (text.includes("INSERT INTO memory_audit_log")) {
        return { rows: [] };
      }
      throw new Error(`unexpected client query: ${text}`);
    });
    const poolQuery = vi.fn();
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    };

    const stats = await drainFlushInbox({
      api: { runtime: { agentId: "main", sessionKey: "agent:main:main" } } as any,
      ctx: {
        disabledReason: undefined,
        cfg: { workspaceDir: "/tmp/work", identity: { externalId: "ext-1" } },
        ensureReady: vi.fn(async () => undefined),
        getPool: () => pool,
        resolveActor: () => "anchorclaw-test",
      } as any,
      workspaceDir: "/tmp/work",
    });

    expect(stats).toEqual({
      scannedFiles: 1,
      importedFiles: 1,
      skippedImportedFiles: 0,
    });
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_import_files"),
      expect.arrayContaining([
        "user-1",
        "workspace-1",
        ".anchorclaw/flush-inbox/2026-06-02/flush-2026-06-02T10-11-12-345Z.md",
      ]),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_daily_entries"),
      expect.arrayContaining([
        "user-1",
        "workspace-1",
        "2026-06-02",
        "memory/2026-06-02.md",
      ]),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_daily_blocks"),
      expect.arrayContaining([
        "user-1",
        "workspace-1",
        "daily-1",
        0,
        "2026-06-02",
        "memory/2026-06-02.md",
      ]),
    );
    expect(unlinkMock).toHaveBeenCalledWith(
      path.join(
        "/tmp/work",
        ".anchorclaw",
        "flush-inbox",
        "2026-06-02",
        "flush-2026-06-02T10-11-12-345Z.md",
      ),
    );
  });
});
