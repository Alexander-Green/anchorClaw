import path from "node:path";
import type { AnchorClawConfig } from "./config.js";

export const WORKSPACE_DIR_UNAVAILABLE = "workspace_dir_unavailable";

export function resolveConfiguredWorkspaceDir(cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined): string | undefined {
  const configured = cfg?.workspaceDir?.trim();
  return configured ? path.resolve(configured) : undefined;
}

export function requireConfiguredWorkspaceDir(cfg: Pick<AnchorClawConfig, "workspaceDir"> | undefined): string {
  const workspaceDir = resolveConfiguredWorkspaceDir(cfg);
  if (!workspaceDir) {
    throw new Error(WORKSPACE_DIR_UNAVAILABLE);
  }
  return workspaceDir;
}
