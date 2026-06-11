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
});
