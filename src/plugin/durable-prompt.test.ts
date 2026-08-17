import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerDurablePromptHook } from "./durable-prompt.js";

function buildHarness() {
  const on = vi.fn();
  const api = {
    logger: { warn: vi.fn() },
    runtime: {
      config: {
        current: () => ({
          agents: {
            list: [
              { id: "main", default: true, workspace: "/agents/main" },
              { id: "ops", workspace: "/agents/ops" },
              { id: "review", workspace: "/agents/ops" },
            ],
          },
        }),
      },
    },
    on,
  } as any;
  const ctx = {
    cfg: {
      postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
    },
    disabledReason: undefined,
    durableState: { overall: "ready" },
    ensureReady: vi.fn(async () => undefined),
  } as any;
  const getPromptMemoryLines = vi.fn(async (target: { workspaceDir: string }) => [
    `durable:${target.workspaceDir}`,
  ]);
  registerDurablePromptHook({
    api,
    ctx,
    getPromptMemoryLines,
  });
  const hook = on.mock.calls.find(
    (call: any[]) => call[0] === "before_prompt_build" && call[2]?.name === "anchorclaw-durable-injection",
  )?.[1];
  return { api, ctx, getPromptMemoryLines, hook };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerDurablePromptHook", () => {
  it("injects durable memory into system context on continuation turns", async () => {
    const { getPromptMemoryLines, hook } = buildHarness();

    const result = await hook(
      { prompt: "continue", messages: [{ role: "user", content: "next" }] },
      {
        agentId: "ops",
        sessionKey: "agent:ops:main",
        workspaceDir: "/agents/ops",
      },
    );

    expect(result).toEqual({
      prependSystemContext: `durable:${path.resolve("/agents/ops")}`,
    });
    expect(result).not.toHaveProperty("prependContext");
    expect(getPromptMemoryLines).toHaveBeenCalledWith({
      workspaceDir: path.resolve("/agents/ops"),
      agentId: "ops",
      sessionKey: "agent:ops:main",
    });
  });

  it("resolves shared-workspace agents to the same workspace target", async () => {
    const { getPromptMemoryLines, hook } = buildHarness();

    await hook(
      { prompt: "review", messages: [] },
      {
        agentId: "review",
        sessionKey: "agent:review:main",
        workspaceDir: "/agents/ops",
      },
    );

    expect(getPromptMemoryLines).toHaveBeenCalledWith({
      workspaceDir: path.resolve("/agents/ops"),
      agentId: "review",
      sessionKey: "agent:review:main",
    });
  });

  it("fails closed when hook identity context is missing", async () => {
    const { api, getPromptMemoryLines, hook } = buildHarness();

    const result = await hook({ prompt: "missing context", messages: [] }, {});

    expect(getPromptMemoryLines).not.toHaveBeenCalled();
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("durable memory is unavailable"),
    });
    expect(result).not.toHaveProperty("prependContext");
    expect(api.logger.warn).toHaveBeenCalledWith(
      "anchorclaw: durable prompt injection failed (runtime_workspace_unavailable)",
    );
  });
});
