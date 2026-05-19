import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

describe("extractMaintenanceCandidates", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("adds internal marker and maintenance session id prefix to the extractor call", async () => {
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _opts: Record<string, unknown>, callback: Function) => {
        callback(
          null,
          JSON.stringify({
            status: "ok",
            result: {
              payloads: [
                {
                  text: JSON.stringify({
                    summary: "summary",
                    candidates: [{ content: "User prefers green", type: "fact" }],
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

    const result = await extractMaintenanceCandidates({
      agentId: "main",
      sourcePath: "episodic",
      fileHash: "episodic",
      transcript: "remember that the favorite color is green",
      maxCandidates: 5,
    });

    expect(result.candidates).toHaveLength(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls[0]?.[1]).toContain(`${MAINTENANCE_SESSION_ID_PREFIX}main`);
    expect(execFileMock.mock.calls[0]?.[1]).toContain("--message");
    const prompt = String(execFileMock.mock.calls[0]?.[1]?.[6] ?? "");
    expect(prompt).toContain(MAINTENANCE_INTERNAL_MARKER);
  });

  it("passes timeout through to execFile", async () => {
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _opts: Record<string, unknown>, callback: Function) => {
        callback(
          null,
          JSON.stringify({
            status: "ok",
            result: {
              payloads: [{ text: JSON.stringify({ summary: "", candidates: [] }) }],
            },
          }),
          "",
        );
      },
    );

    const { extractMaintenanceCandidates } = await import("./extractor.js");

    await extractMaintenanceCandidates({
      agentId: "main",
      sourcePath: "episodic",
      fileHash: "episodic",
      transcript: "remember this",
      maxCandidates: 1,
      timeoutMs: 12_345,
    });

    expect(execFileMock.mock.calls[0]?.[2]).toMatchObject({
      maxBuffer: 10 * 1024 * 1024,
      timeout: 12_345,
    });
  });

  it("fails when candidates is not an array", async () => {
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _opts: Record<string, unknown>, callback: Function) => {
        callback(
          null,
          JSON.stringify({
            status: "ok",
            result: {
              payloads: [{ text: JSON.stringify({ summary: "summary", candidates: {} }) }],
            },
          }),
          "",
        );
      },
    );

    const { extractMaintenanceCandidates } = await import("./extractor.js");

    await expect(
      extractMaintenanceCandidates({
        agentId: "main",
        sourcePath: "episodic",
        fileHash: "episodic",
        transcript: "remember this",
        maxCandidates: 1,
      }),
    ).rejects.toThrow("extractor output.candidates must be an array");
  });

  it("fails when a candidate object is malformed", async () => {
    execFileMock.mockImplementationOnce(
      (_file: string, _args: string[], _opts: Record<string, unknown>, callback: Function) => {
        callback(
          null,
          JSON.stringify({
            status: "ok",
            result: {
              payloads: [{ text: JSON.stringify({ summary: "summary", candidates: [{ type: "fact" }] }) }],
            },
          }),
          "",
        );
      },
    );

    const { extractMaintenanceCandidates } = await import("./extractor.js");

    await expect(
      extractMaintenanceCandidates({
        agentId: "main",
        sourcePath: "episodic",
        fileHash: "episodic",
        transcript: "remember this",
        maxCandidates: 1,
      }),
    ).rejects.toThrow("extractor candidate.content must be a non-empty string");
  });
});
