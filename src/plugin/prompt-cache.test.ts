import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveScope, queryPromptItems, buildPromptSection } = vi.hoisted(() => ({
  resolveScope: vi.fn(),
  queryPromptItems: vi.fn(),
  buildPromptSection: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  resolveUserAndWorkspaceScope: resolveScope,
}));

vi.mock("../memory/prompt.js", () => ({
  queryPromptMemoryItems: queryPromptItems,
  buildPromptMemorySection: buildPromptSection,
}));

import { createPromptMemoryRuntime } from "./prompt-cache.js";

function buildRuntime(options?: { ttlMs?: number; now?: () => number }) {
  const ctx = {
    cfg: {
      postgres: { host: "localhost", database: "anchorclaw", user: "anchorclaw" },
      identity: { externalId: "test-user" },
    },
    disabledReason: undefined,
    ensureReady: vi.fn(async () => undefined),
    getPool: vi.fn(() => ({ query: vi.fn() })),
  } as any;
  return createPromptMemoryRuntime({
    api: { logger: { warn: vi.fn() } } as any,
    ctx,
    ...options,
  });
}

function target(workspaceDir: string, agentId: string) {
  return {
    workspaceDir,
    agentId,
    sessionKey: `agent:${agentId}:main`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveScope.mockImplementation(async ({ workspaceDir }: { workspaceDir: string }) => ({
    userId: "user-1",
    workspaceId: `workspace:${path.resolve(workspaceDir)}`,
  }));
  queryPromptItems.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => [
    {
      id: workspaceId,
      type: "fact",
      title: null,
      content: workspaceId,
      importance: 100,
      updatedAt: "2026-06-10T00:00:00.000Z",
    },
  ]);
  buildPromptSection.mockImplementation(({ items }: { items: Array<{ content: string }> }) => [
    items[0]?.content ?? "",
  ]);
});

describe("createPromptMemoryRuntime", () => {
  it("keeps different workspace snapshots isolated", async () => {
    const runtime = buildRuntime();

    const mainLines = await runtime.getPromptMemoryLines(target("/agents/main", "main"));
    const opsLines = await runtime.getPromptMemoryLines(target("/agents/ops", "ops"));

    expect(mainLines).toEqual([`workspace:${path.resolve("/agents/main")}`]);
    expect(opsLines).toEqual([`workspace:${path.resolve("/agents/ops")}`]);
    expect(queryPromptItems).toHaveBeenCalledTimes(2);
  });

  it("shares one snapshot between agents that resolve to the same workspace path", async () => {
    const runtime = buildRuntime();

    const mainLines = await runtime.getPromptMemoryLines(target("/agents/shared", "main"));
    const opsLines = await runtime.getPromptMemoryLines(target("/agents/shared/.", "ops"));

    expect(opsLines).toEqual(mainLines);
    expect(queryPromptItems).toHaveBeenCalledTimes(1);
  });

  it("invalidates only the selected workspace", async () => {
    const runtime = buildRuntime();
    await runtime.getPromptMemoryLines(target("/agents/main", "main"));
    await runtime.getPromptMemoryLines(target("/agents/ops", "ops"));

    runtime.invalidatePromptMemory({ workspaceDir: "/agents/main" });
    await runtime.getPromptMemoryLines(target("/agents/main", "main"));
    await runtime.getPromptMemoryLines(target("/agents/ops", "ops"));

    expect(queryPromptItems).toHaveBeenCalledTimes(3);
  });

  it("reloads a workspace snapshot after the TTL expires", async () => {
    let nowMs = 1_000;
    const runtime = buildRuntime({ ttlMs: 100, now: () => nowMs });

    await runtime.getPromptMemoryLines(target("/agents/main", "main"));
    nowMs += 99;
    await runtime.getPromptMemoryLines(target("/agents/main", "main"));
    nowMs += 2;
    await runtime.getPromptMemoryLines(target("/agents/main", "main"));

    expect(queryPromptItems).toHaveBeenCalledTimes(2);
  });

  it("does not restore an invalidated snapshot when an older load finishes late", async () => {
    let resolveOldLoad: ((items: any[]) => void) | undefined;
    queryPromptItems
      .mockImplementationOnce(
        () =>
          new Promise<any[]>((resolve) => {
            resolveOldLoad = resolve;
          }),
      )
      .mockResolvedValueOnce([
        {
          id: "fresh",
          type: "fact",
          title: null,
          content: "fresh snapshot",
          importance: 100,
          updatedAt: "2026-06-10T00:00:00.000Z",
        },
      ]);
    const runtime = buildRuntime();
    const workspaceTarget = target("/agents/shared", "main");

    const oldLoad = runtime.getPromptMemoryLines(workspaceTarget);
    await vi.waitFor(() => expect(queryPromptItems).toHaveBeenCalledTimes(1));
    runtime.invalidatePromptMemory({ workspaceDir: workspaceTarget.workspaceDir });
    const freshLines = await runtime.getPromptMemoryLines(workspaceTarget);
    resolveOldLoad?.([
      {
        id: "old",
        type: "fact",
        title: null,
        content: "old snapshot",
        importance: 100,
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    ]);
    await oldLoad;

    expect(freshLines).toEqual(["fresh snapshot"]);
    await expect(runtime.getPromptMemoryLines(workspaceTarget)).resolves.toEqual(["fresh snapshot"]);
    expect(queryPromptItems).toHaveBeenCalledTimes(2);
  });
});
