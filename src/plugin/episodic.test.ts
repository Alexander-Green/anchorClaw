import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerEpisodicHooks } from "./episodic.js";
import { MAINTENANCE_SESSION_ID_PREFIX } from "../maintenance/extractor.js";

const resolveUserAndWorkspaceScope = vi.hoisted(() => vi.fn());

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope,
}));

function buildHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const api = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => Promise<void>) => {
      handlers.set(name, handler);
    }),
    logger: { info: vi.fn(), warn: vi.fn() },
    runtime: {
      agentId: "runtime-agent",
      sessionKey: "runtime-session-key",
      sessionId: "runtime-session",
    },
  } as any;
  const ctx = {
    cfg: {
      workspaceDir: "/workspace",
      postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
    },
    ensureReady: vi.fn(async () => {}),
    getPool: vi.fn(() => ({ query })),
  } as any;
  registerEpisodicHooks({ api, ctx });
  return { api, ctx, handlers, query };
}

function episodicInsertCalls(query: ReturnType<typeof vi.fn>) {
  return query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO memory_episodic"));
}

describe("registerEpisodicHooks", () => {
  beforeEach(() => {
    resolveUserAndWorkspaceScope.mockReset();
    resolveUserAndWorkspaceScope.mockResolvedValue({
      userId: "11111111-1111-1111-1111-111111111111",
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
  });

  it("logs after_tool_call params once and does not duplicate the same tool in agent_end", async () => {
    const { handlers, query } = buildHarness();

    await handlers.get("before_tool_call")?.(
      {
        toolName: "exec",
        toolCallId: "call-1",
        params: { command: "pwd" },
      },
      { agentId: "agent-1", sessionKey: "agent:agent-1:session-1", sessionId: "session-1" },
    );
    expect(episodicInsertCalls(query)).toHaveLength(0);
    await handlers.get("after_tool_call")?.(
      {
        toolName: "exec",
        toolCallId: "call-1",
        params: { command: "pwd" },
        result: { content: [{ type: "text", text: "done" }] },
      },
      { agentId: "agent-1", sessionKey: "agent:agent-1:session-1", sessionId: "session-1" },
    );
    await handlers.get("agent_end")?.(
      {
        success: true,
        durationMs: 42,
        messages: [
          { role: "user", content: "remember that we use episodic maintenance" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call-1",
                function: { name: "exec", arguments: "{\"command\":\"pwd\"}" },
              },
            ],
          },
        ],
      },
      { agentId: "agent-1", sessionKey: "agent:agent-1:session-1", sessionId: "session-1" },
    );

    const inserts = episodicInsertCalls(query);
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1]?.[5]).toBe("tool_execution");
    expect(inserts[0]?.[1]?.[6]).toBe("Tool call: exec");
    expect(JSON.parse(inserts[0]?.[1]?.[7] as string)).toMatchObject({
      toolName: "exec",
      toolCallId: "call-1",
      success: true,
      error: null,
    });
    expect(inserts[1]?.[1]?.[5]).toBe("user_prompt");
  });

  it("skips heartbeat provider events", async () => {
    const { handlers, query } = buildHarness();

    await handlers.get("before_tool_call")?.(
      { toolName: "exec", toolCallId: "call-1", params: { command: "pwd" } },
      { messageProvider: "heartbeat", agentId: "agent-1" },
    );
    await handlers.get("after_tool_call")?.(
      { toolName: "exec", toolCallId: "call-1", params: { command: "pwd" } },
      { messageProvider: "heartbeat", agentId: "agent-1" },
    );
    await handlers.get("agent_end")?.(
      {
        success: true,
        durationMs: 1,
        messages: [{ role: "user", content: "remember this" }],
      },
      { messageProvider: "heartbeat", agentId: "agent-1" },
    );

    expect(episodicInsertCalls(query)).toHaveLength(0);
  });

  it("skips maintenance extractor sessions", async () => {
    const { handlers, query } = buildHarness();
    const maintenanceSessionId = `${MAINTENANCE_SESSION_ID_PREFIX}main`;

    await handlers.get("before_tool_call")?.(
      { toolName: "exec", toolCallId: "call-1", params: { command: "pwd" } },
      { sessionId: maintenanceSessionId, agentId: "main" },
    );
    await handlers.get("after_tool_call")?.(
      { toolName: "exec", toolCallId: "call-1", params: { command: "pwd" } },
      { sessionId: maintenanceSessionId, agentId: "main" },
    );
    await handlers.get("agent_end")?.(
      {
        success: true,
        durationMs: 1,
        messages: [{ role: "user", content: "remember this" }],
      },
      { sessionId: maintenanceSessionId, agentId: "main" },
    );

    expect(episodicInsertCalls(query)).toHaveLength(0);
  });

  it("truncates oversized content and records truncation metadata", async () => {
    const { handlers, query } = buildHarness();
    const hugePrompt = "x".repeat(13_000);

    await handlers.get("agent_end")?.(
      {
        success: true,
        durationMs: 7,
        messages: [{ role: "user", content: hugePrompt }],
      },
      { agentId: "agent-1", sessionKey: "agent:agent-1:session-1", sessionId: "session-1" },
    );

    const inserts = episodicInsertCalls(query);
    expect(inserts).toHaveLength(1);
    expect((inserts[0]?.[1]?.[6] as string).length).toBe(11_000);
    expect(JSON.parse(inserts[0]?.[1]?.[7] as string)).toMatchObject({
      truncated: true,
      originalLength: 13_000,
    });
  });
});
