import { reconcileHostCompatConfig, type HostCompatChange } from "./host-compat-config.js";
import {
  readOpenClawConfigRecord,
  resolveOpenClawConfigPath,
  writeOpenClawConfigRecord,
} from "./openclaw-config-file.js";

export type AnchorClawUpdateOptions = {
  dryRun?: boolean;
};

export type AnchorClawUpdateResult = {
  configPath: string;
  configFound: boolean;
  changes: HostCompatChange[];
  written: boolean;
};

/**
 * Reconciles openclaw.json with what the installed AnchorClaw build needs from the host.
 *
 * Deliberately does not touch PostgreSQL: unlike `anchorclaw setup` this never needs
 * superuser credentials, so it is safe to recommend after every plugin or host upgrade.
 * Database provisioning, maintenance scope, and semantic settings are left alone.
 */
export function applyAnchorClawUpdate(
  options: AnchorClawUpdateOptions = {},
): AnchorClawUpdateResult {
  const configPath = resolveOpenClawConfigPath();
  const cfg = readOpenClawConfigRecord();
  if (!cfg) {
    return { configPath, configFound: false, changes: [], written: false };
  }

  const changes = reconcileHostCompatConfig(cfg);
  const shouldWrite = changes.length > 0 && !options.dryRun;
  if (shouldWrite) {
    writeOpenClawConfigRecord(configPath, cfg);
  }

  return { configPath, configFound: true, changes, written: shouldWrite };
}

export function runAnchorClawUpdate(options: AnchorClawUpdateOptions = {}): AnchorClawUpdateResult {
  const result = applyAnchorClawUpdate(options);

  if (!result.configFound) {
    console.error(`AnchorClaw update: openclaw.json not found at ${result.configPath}`);
    console.error("Run `anchorclaw setup` first, or point OPENCLAW_CONFIG_PATH at the right file.");
    process.exitCode = 1;
    return result;
  }

  console.log(`AnchorClaw update: ${result.configPath}`);
  if (result.changes.length === 0) {
    console.log("- already up to date; no changes needed");
    return result;
  }

  for (const change of result.changes) {
    console.log(`- ${change.path}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
    console.log(`  ${change.reason}`);
  }

  if (options.dryRun) {
    console.log("\nDry run: nothing was written. Re-run without --dry-run to apply.");
    return result;
  }

  console.log("\nRestart the OpenClaw gateway for these settings to take effect.");
  return result;
}
