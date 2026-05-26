import { describe, expect, it, vi } from "vitest";
import { registerMemoryGetTool } from "./memory-get.js";

describe("memory_get tool", () => {
  it("advertises DB-backed OpenClaw memory file compatibility", () => {
    const registerTool = vi.fn();
    const ctx = {
      api: { registerTool },
    } as any;

    registerMemoryGetTool({ ctx } as any);

    const def = registerTool.mock.calls[0]?.[0];
    expect(def.description).toContain("MEMORY.md (virtual snapshot)");
    expect(def.description).toContain("memory/YYYY-MM-DD.md (DB-backed daily memory)");
    expect(def.parameters.properties.lookup.description).toContain("MEMORY.md or memory/YYYY-MM-DD.md");
  });
});
