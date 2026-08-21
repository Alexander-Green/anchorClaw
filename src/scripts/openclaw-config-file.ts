import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function normalizeEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function resolveSafeOsHomedir(): string | undefined {
  try {
    return normalizeEnvPath(homedir());
  } catch {
    return undefined;
  }
}

function resolveOsHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeEnvPath(env.HOME) ?? normalizeEnvPath(env.USERPROFILE) ?? resolveSafeOsHomedir();
}

export function resolveOpenClawHomeDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicitHome = normalizeEnvPath(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveOsHomeDir(env);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const osHome = resolveOsHomeDir(env);
    return osHome ? explicitHome.replace(/^~(?=$|[\\/])/, osHome) : undefined;
  }
  return explicitHome;
}

export function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicitPath = normalizeEnvPath(env.OPENCLAW_CONFIG_PATH);
  if (explicitPath) {
    return resolve(explicitPath);
  }
  const explicitDir = normalizeEnvPath(env.OPENCLAW_CONFIG_DIR);
  if (explicitDir) {
    return resolve(explicitDir, "openclaw.json");
  }
  const home = resolveOpenClawHomeDir(env) ?? ".";
  return resolve(home, ".openclaw", "openclaw.json");
}

export function readOpenClawConfigRecord(): Record<string, any> | undefined {
  const cfgPath = resolveOpenClawConfigPath();
  if (!existsSync(cfgPath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, any>;
}

export function writeOpenClawConfigRecord(cfgPath: string, cfg: Record<string, any>): void {
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
}

export function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}
