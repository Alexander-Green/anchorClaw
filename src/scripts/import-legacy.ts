import path from "node:path";

import type { OpenClawPluginApi } from "../api.js";
import { anchorClawConfigSchema, type AnchorClawConfig } from "../config.js";
import { runLegacyWorkspaceImport, scanLegacyWorkspace } from "../importer.js";
import { createPostgresPool } from "../postgres.js";

export type AnchorClawImportOptions = {
  workspaceDir?: string;
  apply?: boolean;
  keepFiles?: boolean;
};

function resolveCliConfig(api: OpenClawPluginApi, opts: AnchorClawImportOptions): AnchorClawConfig {
  const parsed = anchorClawConfigSchema.parse(api.pluginConfig);
  if (!opts.workspaceDir) {
    return parsed;
  }
  return {
    ...parsed,
    workspaceDir: path.resolve(opts.workspaceDir),
  };
}

function printLegacyScan(scan: Awaited<ReturnType<typeof scanLegacyWorkspace>>) {
  console.log("\nAnchorClaw legacy import scan");
  console.log(`- workspaceDir: ${scan.workspaceDir}`);
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

export async function runAnchorClawImport(api: OpenClawPluginApi, opts: AnchorClawImportOptions = {}): Promise<void> {
  const cfg = resolveCliConfig(api, opts);
  const pool = createPostgresPool({ cfg });
  try {
    const scan = await scanLegacyWorkspace({
      api,
      cfg,
      pool,
      workspaceDir: cfg.workspaceDir,
      agentId: (api as any)?.runtime?.agentId,
      sessionKey: (api as any)?.runtime?.sessionKey,
    });
    printLegacyScan(scan);
    if (!opts.apply) {
      if (scan.hasActiveLegacy) {
        console.log("\nNext step: run `openclaw anchorclaw import --apply` to migrate and archive active legacy files.");
      } else {
        console.log("\nNo active legacy files detected.");
      }
      if (scan.unreadableCount > 0) {
        console.warn(
          "Warning: unreadable legacy daily files were skipped; fix file permissions or contents, then rerun `openclaw anchorclaw import`.",
        );
      }
      return;
    }

    const result = await runLegacyWorkspaceImport({
      api,
      cfg,
      pool,
      workspaceDir: cfg.workspaceDir,
      agentId: (api as any)?.runtime?.agentId,
      sessionKey: (api as any)?.runtime?.sessionKey,
      cleanupMemoryMdAfterImport: !opts.keepFiles,
      archiveImportedFiles: !opts.keepFiles,
    });

    console.log("\nAnchorClaw legacy import complete");
    console.log(`- MEMORY.md import overall: ${result.memoryMdResult.overall}`);
    console.log(`- MEMORY.md import state: ${result.memoryMdResult.import}`);
    console.log(`- MEMORY.md cleanup state: ${result.memoryMdResult.cleanup}`);
    console.log(`- daily files imported: ${result.dailyImportedCount}`);
    console.log(`- daily files already imported: ${result.dailySkippedImportedCount}`);
    console.log(`- daily files archived: ${result.dailyArchivedCount}`);
    console.log(`- unsupported daily files: ${result.dailyUnsupportedCount}`);
    if (opts.keepFiles) {
      console.warn("Warning: --keep-files leaves legacy files active and can reintroduce duplicate prompt injection risk.");
    }
    if (result.memoryMdResult.reason) {
      console.warn(`Warning: ${result.memoryMdResult.reason}`);
    }
  } finally {
    await pool.end();
  }
}
