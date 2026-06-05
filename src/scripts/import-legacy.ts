import type { OpenClawPluginApi } from "../api.js";
import { anchorClawConfigSchema, type AnchorClawConfig } from "../config.js";
import { runLegacyWorkspaceImport, scanLegacyWorkspace } from "../importer.js";
import { createPostgresPool } from "../postgres.js";
import {
  planAnchorClawImportTargets,
  type AnchorClawImportOptions,
  type PlannedAnchorClawImportTarget,
} from "./import-legacy-plan.js";

function resolveCliConfig(api: OpenClawPluginApi): AnchorClawConfig {
  return anchorClawConfigSchema.parse(api.pluginConfig);
}

function printLegacyScan(target: PlannedAnchorClawImportTarget, scan: Awaited<ReturnType<typeof scanLegacyWorkspace>>) {
  console.log(`\nAnchorClaw legacy import scan (${target.label})`);
  console.log(`- sourceDir: ${scan.sourceDir}`);
  console.log(`- targetWorkspaceDir: ${scan.targetWorkspaceDir}`);
  console.log(`- MEMORY.md: ${scan.memoryMd.state}`);
  if (scan.memoryMd.sha256) {
    console.log(`- MEMORY.md sha256: ${scan.memoryMd.sha256}`);
  }
  console.log(`- active legacy files: ${scan.activeLegacyCount}`);
  console.log(`- pending imports: ${scan.pendingCount}`);
  console.log(`- unsupported daily files: ${scan.unsupportedCount}`);
  console.log(`- unreadable daily files: ${scan.unreadableCount}`);
  if (scan.dailyFiles.length > 0) {
    for (const file of scan.dailyFiles) {
      const suffix = file.error ? ` (${file.error})` : "";
      console.log(`- ${file.path}: ${file.state}${suffix}`);
    }
  }
}

function buildApplyHint(opts: AnchorClawImportOptions): string {
  const parts = ["openclaw anchorclaw import"];
  if (opts.sourceDir) {
    parts.push(`--source-dir ${opts.sourceDir}`);
  }
  if (opts.defaultAgent) {
    parts.push("--default-agent");
  } else if (opts.agent) {
    parts.push(`--agent ${opts.agent}`);
  } else if (opts.allAgentWorkspaces) {
    parts.push("--all-agent-workspaces");
  }
  if (opts.keepFiles) {
    parts.push("--keep-files");
  }
  parts.push("--apply");
  return parts.join(" ");
}

export async function runAnchorClawImport(api: OpenClawPluginApi, opts: AnchorClawImportOptions = {}): Promise<void> {
  const cfg = resolveCliConfig(api);
  const runtimeConfig =
    typeof (api as any)?.runtime?.config?.current === "function"
      ? ((api as any).runtime.config.current() as any)
      : undefined;
  const targets = planAnchorClawImportTargets({
    cfg,
    opts,
    runtimeConfig,
    runtimeAgentId: (api as any)?.runtime?.agentId,
    runtimeSessionKey: (api as any)?.runtime?.sessionKey,
  });
  const pool = createPostgresPool({ cfg });
  try {
    let hasActiveLegacy = false;
    let unreadableCount = 0;

    for (const target of targets) {
      if (target.deprecatedWorkspaceDirFallback) {
        console.warn(
          "Warning: OpenClaw runtime config was unavailable; falling back to anchorclaw.workspaceDir for target resolution.",
        );
      }

      const scan = await scanLegacyWorkspace({
        api,
        cfg,
        pool,
        sourceDir: target.sourceDir,
        targetWorkspaceDir: target.targetWorkspaceDir,
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      });
      printLegacyScan(target, scan);
      hasActiveLegacy = hasActiveLegacy || scan.hasActiveLegacy;
      unreadableCount += scan.unreadableCount;

      if (opts.apply) {
        const result = await runLegacyWorkspaceImport({
          api,
          cfg,
          pool,
          sourceDir: target.sourceDir,
          targetWorkspaceDir: target.targetWorkspaceDir,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          cleanupMemoryMdAfterImport: !opts.keepFiles,
          archiveImportedFiles: !opts.keepFiles,
        });

        console.log(`\nAnchorClaw legacy import complete (${target.label})`);
        console.log(`- MEMORY.md import overall: ${result.memoryMdResult.overall}`);
        console.log(`- MEMORY.md import state: ${result.memoryMdResult.import}`);
        console.log(`- MEMORY.md cleanup state: ${result.memoryMdResult.cleanup}`);
        console.log(`- daily files imported: ${result.dailyImportedCount}`);
        console.log(`- daily files already imported: ${result.dailySkippedImportedCount}`);
        console.log(`- daily files archived: ${result.dailyArchivedCount}`);
        console.log(`- unsupported daily files: ${result.dailyUnsupportedCount}`);
        if (result.memoryMdResult.reason) {
          console.warn(`Warning (${target.label}): ${result.memoryMdResult.reason}`);
        }
      }
    }

    if (!opts.apply) {
      if (hasActiveLegacy) {
        console.log(`\nNext step: run \`${buildApplyHint(opts)}\` to migrate and archive active legacy files.`);
      } else {
        console.log("\nNo active legacy files detected across the selected import targets.");
      }
      if (unreadableCount > 0) {
        console.warn(
          "Warning: unreadable legacy daily files were skipped; fix file permissions or contents, then rerun `openclaw anchorclaw import`.",
        );
      }
      return;
    }

    if (opts.keepFiles) {
      console.warn("Warning: --keep-files leaves legacy files active and can reintroduce duplicate prompt injection risk.");
    }
  } finally {
    await pool.end();
  }
}
