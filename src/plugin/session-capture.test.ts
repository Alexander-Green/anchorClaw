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
            list: [{ id: "main", default: true, workspace: "/tmp/work" }],
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
        return {
          rows: [{
            id: "daily-1",
            content: "capture",
            content_sha256: "daily-sha",
            source_kind: "session_memory",
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
          { role: "system", content: "ignore me" },
          { role: "user", content: "/new" },
          {
            role: "user",
            content: "inter-session carryover",
            provenance: { kind: "inter_session", sourceSessionKey: "agent:main:older" },
          },
          { role: "user", content: "Remember the C0.2 canary." },
          { role: "assistant", content: [{ type: "text", text: "I will keep it in daily memory." }] },
        ],
      },
    });

    expect(result).toEqual({
      status: "captured",
      relPath: expect.stringMatching(/^\.anchorclaw\/session-capture\/2026-06-02\/[0-9a-f]{32}\.md$/u),
      targetPath: expect.stringMatching(/^memory\/2026-06-02-\d{4}-[0-9a-f]{8}-session-capture\.md$/u),
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
        expect.stringMatching(/^memory\/2026-06-02-\d{4}-[0-9a-f]{8}-session-capture\.md$/u),
        expect.stringMatching(/### Conversation Summary[\s\S]*user: Remember the C0\.2 canary\.[\s\S]*assistant: I will keep it in daily memory\./u),
        expect.any(String),
        "session_memory",
      ]),
    );
  });

  it("keeps only the last 15 user/assistant messages", async () => {
    const capturedDailyArgs: unknown[][] = [];
    const clientQuery = vi.fn(async (sql: string, args?: unknown[]) => {
      const text = String(sql);
      if (text === "BEGIN" || text === "COMMIT") return { rows: [] };
      if (text.includes("INSERT INTO memory_import_files")) {
        return { rows: [{ id: "ledger-1" }] };
      }
      if (text.includes("SELECT id, content, updated_at") && text.includes("FROM memory_daily_entries")) {
        return { rows: [] };
      }
      if (text.includes("INSERT INTO memory_daily_entries")) {
        if (Array.isArray(args)) {
          capturedDailyArgs.push(args);
        }
        return {
          rows: [{
            id: "daily-1",
            content: String(args?.[4] ?? ""),
            content_sha256: "daily-sha",
            source_kind: "session_memory",
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
      throw new Error(`unexpected query: ${text}`);
    });
    const pool = {
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    };

    const messages = Array.from({ length: 17 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index + 1}`,
    }));

    const result = await captureBeforeResetSessionMemory({
      api: buildApi(),
      ctx: buildCtx(pool),
      nowMs: Date.parse("2026-06-02T10:11:12.345Z"),
      hookContext: {
        workspaceDir: "/tmp/work",
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "session-15",
      },
      event: {
        reason: "reset",
        messages,
      },
    });

    expect(result.status).toBe("captured");
    const content = capturedDailyArgs[0]?.[4];
    expect(typeof content).toBe("string");
    expect(String(content)).not.toMatch(/\bmessage-1\b/u);
    expect(String(content)).not.toMatch(/\bmessage-2\b/u);
    expect(String(content)).toMatch(/\bmessage-3\b/u);
    expect(String(content)).toMatch(/\bmessage-17\b/u);
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
        agentId: "main",
        sessionKey: "agent:main:main",
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
      targetPath: expect.stringMatching(/^memory\/2026-06-02-\d{4}-[0-9a-f]{8}-session-capture\.md$/u),
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

  it("rejects sparse hook context instead of mixing it with global runtime identity", async () => {
    const pool = {
      connect: vi.fn(),
    };

    await expect(
      captureBeforeResetSessionMemory({
        api: buildApi(),
        ctx: buildCtx(pool),
        hookContext: {
          workspaceDir: "/agents/ops",
          sessionId: "ops-session",
        },
        event: {
          reason: "reset",
          messages: [{ role: "user", content: "ops memory must not be attributed to main" }],
        },
      }),
    ).rejects.toThrow("runtime_workspace_unavailable: agent_unavailable");
    expect(resolveScopeMock).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("uses the complete global runtime scope only when hook context is absent", async () => {
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
      event: {
        reason: "reset",
        messages: [{ role: "user", content: "legacy runtime capture" }],
      },
    });

    expect(result.status).toBe("already_captured");
    expect(resolveScopeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/work",
        agentId: "main",
        sessionKey: "agent:main:main",
      }),
    );
  });
});
