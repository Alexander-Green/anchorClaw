import path from "node:path";
import type { AnchorClawConfig } from "./config.js";

export const WORKSPACE_DIR_UNAVAILABLE = "workspace_dir_unavailable";

export type ConfiguredLegacyImportScope = {
  sourceDir: string;
  targetWorkspaceDir: string;
  workspaceDir: string;
};

export function resolveConfiguredWorkspaceDir(cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined): string | undefined {
  const configured = cfg?.workspaceDir?.trim();
  return configured ? path.resolve(configured) : undefined;
}

export function resolveConfiguredLegacyImportScope(
  cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined,
): ConfiguredLegacyImportScope | undefined {
  const workspaceDir = resolveConfiguredWorkspaceDir(cfg);
  if (!workspaceDir) {
    return undefined;
  }
  return {
    sourceDir: workspaceDir,
    targetWorkspaceDir: workspaceDir,
    workspaceDir,
  };
}

export function requireConfiguredWorkspaceDir(cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined): string {
  const workspaceDir = resolveConfiguredWorkspaceDir(cfg);
  if (!workspaceDir) {
    throw new Error(WORKSPACE_DIR_UNAVAILABLE);
  }
  return workspaceDir;
}

export function requireConfiguredLegacyImportScope(
  cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined,
): ConfiguredLegacyImportScope {
  const scope = resolveConfiguredLegacyImportScope(cfg);
  if (!scope) {
    throw new Error(WORKSPACE_DIR_UNAVAILABLE);
  }
  return scope;
}
