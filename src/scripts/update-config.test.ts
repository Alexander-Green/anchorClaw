import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAnchorClawUpdate } from "./update-config.js";

let workDir: string;
let configPath: string;
let previousConfigPath: string | undefined;

function writeConfig(cfg: Record<string, any>) {
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

function readConfig(): Record<string, any> {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "anchorclaw-update-"));
  configPath = join(workDir, "openclaw.json");
  previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
});

afterEach(() => {
  if (previousConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe("anchorclaw update", () => {
  it("adds the conversation access flag to an existing install", () => {
    writeConfig({
      plugins: {
        entries: {
          anchorclaw: {
            enabled: true,
            hooks: { allowPromptInjection: true },
            config: { postgres: { host: "127.0.0.1", password: "${ANCHORCLAW_DB_PASSWORD}" } },
          },
        },
        slots: { memory: "anchorclaw" },
      },
      hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
    });

    const result = applyAnchorClawUpdate();

    expect(result.written).toBe(true);
    expect(result.changes.map((change) => change.path)).toEqual([
      "plugins.entries.anchorclaw.hooks.allowConversationAccess",
    ]);
    expect(readConfig().plugins.entries.anchorclaw.hooks.allowConversationAccess).toBe(true);
  });

  it("never touches database or maintenance settings", () => {
    const postgres = { host: "db.internal", port: 6432, password: "${ANCHORCLAW_DB_PASSWORD}" };
    const maintenance = { enabled: false, intervalMinutes: 30, extractor: { enabled: false } };
    writeConfig({
      plugins: { entries: { anchorclaw: { config: { postgres, maintenance } } } },
    });

    applyAnchorClawUpdate();

    const cfg = readConfig();
    expect(cfg.plugins.entries.anchorclaw.config.postgres).toEqual(postgres);
    expect(cfg.plugins.entries.anchorclaw.config.maintenance).toEqual(maintenance);
  });

  it("is a no-op on an already reconciled config", () => {
    writeConfig({
      plugins: {
        entries: {
          anchorclaw: { hooks: { allowPromptInjection: true, allowConversationAccess: true } },
        },
      },
      hooks: { internal: { entries: { "session-memory": { enabled: false } } } },
    });
    const before = readFileSync(configPath, "utf-8");

    const result = applyAnchorClawUpdate();

    expect(result.changes).toEqual([]);
    expect(result.written).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("reports changes without writing in dry-run mode", () => {
    writeConfig({ plugins: { entries: { anchorclaw: {} } } });
    const before = readFileSync(configPath, "utf-8");

    const result = applyAnchorClawUpdate({ dryRun: true });

    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.written).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("reports a missing config instead of creating one", () => {
    rmSync(configPath, { force: true });

    const result = applyAnchorClawUpdate();

    expect(result.configFound).toBe(false);
    expect(result.written).toBe(false);
    expect(result.changes).toEqual([]);
  });
});
