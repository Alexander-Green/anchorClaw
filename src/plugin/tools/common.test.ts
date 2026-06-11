import { describe, expect, it, vi } from "vitest";

import {
  ensureToolRuntimeReady,
  resolveRuntimeToolWorkspace,
} from "./common.js";

describe("ensureToolRuntimeReady", () => {
  it("retries startup when the previous failure is retryable", async () => {
    const ctx = {
      disabledReason: undefined,
      startupCriticalFailure: "db_readiness_failed: connection refused",
      durableState: {
        overall: "blocked",
        import: "failed_retryable",
        reason: "db_readiness_failed: connection refused",
      },
    } as any;
    const ensureStartupBootstrap = vi.fn(async () => {
      ctx.startupCriticalFailure = undefined;
      ctx.durableState = {
        ...ctx.durableState,
        overall: "ready",
        import: "not_needed",
        reason: null,
      };
    });

    await expect(
      ensureToolRuntimeReady(ctx, ensureStartupBootstrap),
    ).resolves.toBeNull();
    expect(ensureStartupBootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("resolveRuntimeToolWorkspace", () => {
  it("returns diagnostic details and logs when live workspace mismatches configured agent workspace", () => {
    const warn = vi.fn();
    const result = resolveRuntimeToolWorkspace({
      ctx: {
        api: {
          logger: { warn },
          runtime: {
            config: {
              current: () => ({
                agents: {
                  list: [{ id: "ops", workspace: "/agents/ops" }],
                },
              }),
            },
          },
        },
      } as any,
      workspaceDir: "/runtime/other",
      agentId: "ops",
    });

    expect(result).toEqual({
      content: [{ type: "text", text: "anchorclaw: tool unavailable (runtime_workspace_mismatch)" }],
      details: {
        disabled: true,
        error: "runtime_workspace_mismatch",
        reason: "workspace_mismatch",
        agentId: "ops",
        contextWorkspaceDir: "/runtime/other",
        configuredWorkspaceDir: "/agents/ops",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "anchorclaw: runtime workspace resolution failed for agent ops (workspace_mismatch: runtime workspace mismatch for agent ops) (context=/runtime/other, configured=/agents/ops)",
    );
  });
});
