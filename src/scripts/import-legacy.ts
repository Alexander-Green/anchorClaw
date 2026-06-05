import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "../api.js";
import { anchorClawConfigSchema, type AnchorClawConfig } from "../config.js";
import { runLegacyWorkspaceImport, scanLegacyWorkspace } from "../importer.js";
import { createPostgresPool } from "../postgres.js";
import { resolveWorkspaceTargets } from "../workspace-targets.js";
import {
  planAnchorClawImportTargets,
  type AnchorClawImportOptions,
  type PlannedAnchorClawImportTarget,
} from "./import-legacy-plan.js";

function resolveCliConfig(api: OpenClawPluginApi): AnchorClawConfig {
  return anchorClawConfigSchema.parse(api.pluginConfig);
}

function hasExplicitImportSelector(opts: AnchorClawImportOptions): boolean {
  return Boolean(opts.defaultAgent || opts.agent?.trim() || opts.allAgentWorkspaces);
}

type InteractiveImportChoice = {
  label: string;
  workspaceSummary: string;
  options: AnchorClawImportOptions;
};

function dedupeChoices(choices: InteractiveImportChoice[]): InteractiveImportChoice[] {
  const seen = new Set<string>();
  const deduped: InteractiveImportChoice[] = [];
  for (const choice of choices) {
    const key = JSON.stringify({
      defaultAgent: Boolean(choice.options.defaultAgent),
      agent: choice.options.agent ?? null,
      allAgentWorkspaces: Boolean(choice.options.allAgentWorkspaces),
      sourceDir: choice.options.sourceDir ?? null,
      apply: Boolean(choice.options.apply),
      keepFiles: Boolean(choice.options.keepFiles),
      nonInteractive: Boolean(choice.options.nonInteractive),
    });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(choice);
  }
  return deduped;
}

function buildInteractiveImportChoices(params: {
  opts: AnchorClawImportOptions;
  runtimeConfig?: any;
}): InteractiveImportChoice[] {
  if (!params.runtimeConfig) {
    return [];
  }

  const choices: InteractiveImportChoice[] = [];
  const defaultAgentId = resolveDefaultAgentId(params.runtimeConfig);
  const [defaultTarget] = resolveWorkspaceTargets({
    runtimeConfig: params.runtimeConfig,
    selector: { mode: "default-agent" },
  });
  choices.push({
    label: `default agent ${defaultAgentId}`,
    workspaceSummary: defaultTarget.workspaceDir,
    options: { ...params.opts, defaultAgent: true },
  });

  for (const agentId of listAgentIds(params.runtimeConfig)) {
    if (agentId === defaultAgentId) {
      continue;
    }
    const [agentTarget] = resolveWorkspaceTargets({
      runtimeConfig: params.runtimeConfig,
      selector: { mode: "agent", agentId },
    });
    choices.push({
      label: `agent ${agentId}`,
      workspaceSummary: agentTarget.workspaceDir,
      options: { ...params.opts, agent: agentId },
    });
  }

  if (!params.opts.sourceDir) {
    const allTargets = resolveWorkspaceTargets({
      runtimeConfig: params.runtimeConfig,
      selector: { mode: "all-agent-workspaces" },
    });
    if (allTargets.length > 1) {
      choices.push({
        label: "all agent workspaces",
        workspaceSummary: allTargets.map((target) => `${target.label} -> ${target.workspaceDir}`).join(" | "),
        options: { ...params.opts, allAgentWorkspaces: true },
      });
    }
  }

  return dedupeChoices(choices);
}

async function resolveInteractiveImportOptions(params: {
  opts: AnchorClawImportOptions;
  runtimeConfig?: any;
}): Promise<AnchorClawImportOptions> {
  if (hasExplicitImportSelector(params.opts) || params.opts.nonInteractive) {
    return params.opts;
  }

  const choices = buildInteractiveImportChoices(params);
  if (choices.length === 0) {
    throw new Error("OpenClaw runtime config is unavailable; import target selection requires it.");
  }

  console.log("\nSelect AnchorClaw import target:");
  for (const [index, choice] of choices.entries()) {
    console.log(`${index + 1}. ${choice.label} -> ${choice.workspaceSummary}`);
  }

  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question("Choice [1]: ")).trim();
      if (!answer) {
        return choices[0]!.options;
      }
      const selected = Number.parseInt(answer, 10);
      if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
        return choices[selected - 1]!.options;
      }
      console.warn(`Invalid selection: ${JSON.stringify(answer)}. Enter a number from 1 to ${choices.length}.`);
    }
  } finally {
    rl.close();
  }
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
  const effectiveOpts = await resolveInteractiveImportOptions({
    opts,
    runtimeConfig,
  });
  const targets = planAnchorClawImportTargets({
    opts: effectiveOpts,
    runtimeConfig,
    runtimeAgentId: (api as any)?.runtime?.agentId,
    runtimeSessionKey: (api as any)?.runtime?.sessionKey,
  });
  const pool = createPostgresPool({ cfg });
  try {
    let hasActiveLegacy = false;
    let unreadableCount = 0;

    for (const target of targets) {
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

      if (effectiveOpts.apply) {
        const result = await runLegacyWorkspaceImport({
          api,
          cfg,
          pool,
          sourceDir: target.sourceDir,
          targetWorkspaceDir: target.targetWorkspaceDir,
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          cleanupMemoryMdAfterImport: !effectiveOpts.keepFiles,
          archiveImportedFiles: !effectiveOpts.keepFiles,
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

    if (!effectiveOpts.apply) {
      if (hasActiveLegacy) {
        console.log(`\nNext step: run \`${buildApplyHint(effectiveOpts)}\` to migrate and archive active legacy files.`);
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

    if (effectiveOpts.keepFiles) {
      console.warn("Warning: --keep-files leaves legacy files active and can reintroduce duplicate prompt injection risk.");
    }
  } finally {
    await pool.end();
  }
}
