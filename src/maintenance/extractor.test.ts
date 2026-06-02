import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("extractMaintenanceCandidates", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  it("re-exports maintenance constants and parses openclaw --json output", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(
          null,
          JSON.stringify({
            status: "ok",
            result: {
              payloads: [
                {
                  text: JSON.stringify({
                    summary: "daily summary",
                    candidates: [
                      {
                        content: "User prefers green accents in the UI.",
                        type: "fact",
                        canonicalKey: "ui:favorite-color",
                        confidence: 91.8,
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          "",
        );
      },
    );

    const { extractMaintenanceCandidates, MAINTENANCE_INTERNAL_MARKER, MAINTENANCE_SESSION_ID_PREFIX } =
      await import("./extractor.js");

    expect(MAINTENANCE_INTERNAL_MARKER).toBe("[POSTCLAW_INTERNAL_LLM_CALL_DO_NOT_LOG]");
    expect(MAINTENANCE_SESSION_ID_PREFIX).toBe("anchorclaw-maintenance-");

    const result = await extractMaintenanceCandidates({
      agentId: "main",
      sourcePath: "memory/2026-06-02.md#window=1",
      fileHash: "abc123",
      transcript: "remember that green is the preferred accent color",
      maxCandidates: 5,
    });

    expect(result).toEqual({
      summary: "daily summary",
      candidates: [
        {
          content: "User prefers green accents in the UI.",
          type: "fact",
          canonicalKey: "ui:favorite-color",
          confidence: 91,
        },
      ],
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "agent",
        "--agent",
        "main",
        "--session-id",
        "anchorclaw-maintenance-main",
        "--json",
      ]),
    );
    expect(String(execFileMock.mock.calls[0]?.[1]?.[6] ?? "")).toContain("AnchorClaw daily memory");
  });

  it("surfaces invocation failures", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(new Error("spawn failed"), "", "boom");
      },
    );

    const { extractMaintenanceCandidates } = await import("./extractor.js");

    await expect(
      extractMaintenanceCandidates({
        agentId: "main",
        sourcePath: "memory/2026-06-02.md#window=1",
        fileHash: "abc123",
        transcript: "remember something durable",
        maxCandidates: 5,
      }),
    ).rejects.toThrow("extractor invocation failed (boom)");
  });
});
