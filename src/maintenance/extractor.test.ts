import { beforeEach, describe, expect, it, vi } from "vitest";

describe("extractMaintenanceCandidates", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("re-exports maintenance constants for archived episodic helpers", async () => {
    const { extractMaintenanceCandidates, MAINTENANCE_INTERNAL_MARKER, MAINTENANCE_SESSION_ID_PREFIX } =
      await import("./extractor.js");

    expect(MAINTENANCE_INTERNAL_MARKER).toBe("[POSTCLAW_INTERNAL_LLM_CALL_DO_NOT_LOG]");
    expect(MAINTENANCE_SESSION_ID_PREFIX).toBe("anchorclaw-maintenance-");
    await expect(
      extractMaintenanceCandidates({
        agentId: "main",
        sourcePath: "episodic",
        fileHash: "episodic",
        transcript: "remember that the favorite color is green",
        maxCandidates: 5,
      }),
    ).rejects.toThrow("maintenance extractor is unavailable in this release build");
  });
});
