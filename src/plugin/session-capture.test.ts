import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveScopeMock } = vi.hoisted(() => ({
  resolveScopeMock: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScopeMock,
}));

import { captureBeforeResetSessionMemory } from "./session-capture.js";

function buildApi() {
  return {
    runtime: {
      agentId: "main",
      sessionKey: "agent:main:main",
      config: {
        current: () => ({
          agents: {
            defaults: {
              userTimezone: "Asia/Almaty",
            },
          },
        }),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  } as any;
}

function buildCtx(pool: any) {
  return {
    disabledReason: undefined,
    cfg: {
      workspaceDir: "/tmp/work",
      identity: {
        externalId: "ext-1",
      },
    },
    ensureReady: vi.fn(async () => undefined),
    getPool: () => pool,
    resolveActor: () => "anchorclaw-test",
  } as any;
}

describe("session capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveScopeMock.mockResolvedValue({
      userId: "user-1",
      workspaceId: "workspace-1",
    });
  });

  it("captures before_reset messages into DB daily memory", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("INSERT INTO memory_import_files")) {
        return { rows: [{ id: "ledger-1" }] };
      }
      if (text.includes("SELECT id, content, updated_at") && text.includes("FROM memory_daily_entries")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO memory_daily_entries")) {
        return { rows: [{ id: "daily-1", updated_at: "2026-06-02T10:12:00.000Z" }] };
      }
      if (text.includes("INSERT INTO memory_audit_log")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    };

    const result = await captureBeforeResetSessionMemory({
      api: buildApi(),
      ctx: buildCtx(pool),
      nowMs: Date.parse("2026-06-02T10:11:12.345Z"),
      hookContext: {
        workspaceDir: "/tmp/work",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-1",
      },
      event: {
        reason: "new",
        sessionFile: "/tmp/.openclaw/agents/main/sessions/a.jsonl",
        messages: [
          { role: "user", content: "Remember the C0.2 canary." },
          { role: "assistant", content: [{ type: "text", text: "I will keep it in daily memory." }] },
        ],
      },
    });

    expect(result).toEqual({
      status: "captured",
      relPath: expect.stringMatching(/^\.anchorclaw\/session-capture\/2026-06-02\/[0-9a-f]{32}\.md$/u),
      targetPath: "memory/2026-06-02.md",
      dailyEntryId: "daily-1",
    });
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/work",
        agentId: "main",
        sessionKey: "agent:main:main",
        configuredExternalId: "ext-1",
      }),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_import_files"),
      expect.arrayContaining([
        "user-1",
        "workspace-1",
        expect.stringMatching(/^\.anchorclaw\/session-capture\/2026-06-02\/[0-9a-f]{32}\.md$/u),
        expect.any(String),
        "session-capture",
      ]),
    );
    expect(clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_daily_entries"),
      expect.arrayContaining([
        "user-1",
        "workspace-1",
        "2026-06-02",
        "memory/2026-06-02.md",
        expect.stringContaining("Remember the C0.2 canary."),
        expect.any(String),
        "session_memory",
      ]),
    );
  });

  it("does not append duplicate daily blocks when the source was already captured", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("INSERT INTO memory_import_files")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query after ledger conflict: ${text}`);
    });
    const pool = {
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    };

    const result = await captureBeforeResetSessionMemory({
      api: buildApi(),
      ctx: buildCtx(pool),
      nowMs: Date.parse("2026-06-02T10:11:12.345Z"),
      hookContext: {
        workspaceDir: "/tmp/work",
        sessionId: "session-1",
      },
      event: {
        reason: "reset",
        messages: [{ role: "user", content: "same session replay" }],
      },
    });

    expect(result).toEqual({
      status: "already_captured",
      relPath: expect.stringMatching(/^\.anchorclaw\/session-capture\/2026-06-02\/[0-9a-f]{32}\.md$/u),
      targetPath: "memory/2026-06-02.md",
    });
    expect(clientQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO memory_daily_entries"),
      expect.anything(),
    );
  });

  it("skips empty reset events", async () => {
    const pool = {
      connect: vi.fn(),
    };

    const result = await captureBeforeResetSessionMemory({
      api: buildApi(),
      ctx: buildCtx(pool),
      event: {
        reason: "new",
        messages: [],
      },
    });

    expect(result).toEqual({ status: "empty" });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
