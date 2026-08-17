import { describe, expect, it, vi } from "vitest";
import { registerMemoryGetTool } from "./memory-get.js";

describe("memory_get tool", () => {
  it("advertises DB-backed OpenClaw memory file compatibility", () => {
    const registerTool = vi.fn();
    const ctx = {
      api: { registerTool },
    } as any;

    registerMemoryGetTool({ ctx } as any);

    const factory = registerTool.mock.calls[0]?.[0];
    const opts = registerTool.mock.calls[0]?.[1];
    expect(opts).toEqual({ name: "memory_get" });
    expect(factory).toBeTypeOf("function");
    const def = factory({
      runtimeConfig: {
        agents: {
          list: [{ id: "main", default: true, workspace: "/runtime/workspace" }],
        },
      },
      workspaceDir: "/runtime/workspace",
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(def.description).toContain("MEMORY.md (virtual snapshot)");
    expect(def.description).toContain("memory/YYYY-MM-DD.md (DB-backed daily memory)");
    expect(def.parameters.properties.lookup.description).toContain("MEMORY.md or memory/YYYY-MM-DD.md");
  });

  it("redirects native session paths before AnchorClaw bootstrap and database readiness", async () => {
    const registerTool = vi.fn();
    const ensureReady = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const getPool = vi.fn(() => {
      throw new Error("database must not be accessed");
    });
    const ensureStartupBootstrap = vi.fn(async () => {
      throw new Error("bootstrap must not run");
    });
    const ctx = {
      api: {
        registerTool,
        runtime: { version: "2026.8.1-beta.1" },
      },
      ensureReady,
      getPool,
      durableState: {
        overall: "blocked",
        migrations: "failed",
        reason: "migrations_failed: database unavailable",
      },
    } as any;
    registerMemoryGetTool({ ctx, ensureStartupBootstrap } as any);
    const factory = registerTool.mock.calls[0]?.[0];
    const def = factory({});

    const result = await def.execute("toolcall-native-get", {
      lookup: "sessions/main/session.jsonl",
    });

    expect(result.content[0].text).toContain("use sessions_search and sessions_history");
    expect(result.details.replacementTools).toEqual(["sessions_search", "sessions_history"]);
    expect(ensureStartupBootstrap).not.toHaveBeenCalled();
    expect(ensureReady).not.toHaveBeenCalled();
    expect(getPool).not.toHaveBeenCalled();
  });
});
