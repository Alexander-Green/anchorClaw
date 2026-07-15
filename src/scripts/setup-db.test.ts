import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const readlineState = vi.hoisted(() => ({
  answers: [] as string[],
}));

const pgState = vi.hoisted(() => ({
  clients: [] as Array<{
    connectionString: string;
    queries: Array<{ text: string; values?: unknown[] }>;
  }>,
  tableRows: [] as Array<{ table_name: string }>,
  tableOwnerRows: [] as Array<{ table_name: string; table_owner: string }>,
  dbExists: false,
  userExists: false,
}));

vi.mock("pg", () => {
  class MockClient {
    private readonly state: {
      connectionString: string;
      queries: Array<{ text: string; values?: unknown[] }>;
    };

    constructor(params: { connectionString: string }) {
      this.state = { connectionString: params.connectionString, queries: [] };
      pgState.clients.push(this.state);
    }

    async connect() {
      return undefined;
    }

    async query(text: string, values?: unknown[]) {
      this.state.queries.push({ text, values });
      if (text.includes("FROM pg_database")) {
        return { rowCount: pgState.dbExists ? 1 : 0, rows: pgState.dbExists ? [{ one: 1 }] : [] };
      }
      if (text.includes("FROM pg_roles")) {
        return { rowCount: pgState.userExists ? 1 : 0, rows: pgState.userExists ? [{ one: 1 }] : [] };
      }
      if (text.includes("FROM information_schema.tables")) {
        return { rowCount: pgState.tableRows.length, rows: pgState.tableRows };
      }
      if (text.includes("FROM pg_tables")) {
        return { rowCount: pgState.tableOwnerRows.length, rows: pgState.tableOwnerRows };
      }
      return { rowCount: 0, rows: [] };
    }

    async end() {
      return undefined;
    }
  }
  return { Client: MockClient };
});

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: vi.fn(async () => readlineState.answers.shift() ?? ""),
    close: vi.fn(),
  })),
}));

import { runAnchorClawSetup } from "./setup-db.js";

describe("runAnchorClawSetup", () => {
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    readlineState.answers = [];
    pgState.clients = [];
    pgState.tableRows = [];
    pgState.tableOwnerRows = [];
    pgState.dbExists = false;
    pgState.userExists = false;
    consoleLogSpy.mockClear();
    consoleWarnSpy.mockClear();
  });

  it("supports schema-none fallback without schema SQL", async () => {
    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw",
      dbUser: "anchorclaw",
      dbPassword: "secret",
      schemaNone: true,
    });

    const allSql = pgState.clients.flatMap((c) => c.queries.map((q) => q.text)).join("\n");
    expect(allSql).not.toContain("CREATE SCHEMA IF NOT EXISTS");
    expect(allSql).toContain("CREATE DATABASE");
  });

  it("accepts database names with hyphens", async () => {
    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw-memory",
      dbUser: "anchorclaw",
      dbPassword: "secret",
      schema: "memory",
    });

    const allSql = pgState.clients.flatMap((c) => c.queries.map((q) => q.text)).join("\n");
    expect(allSql).toContain('CREATE DATABASE "anchorclaw-memory"');
    expect(allSql).toContain('ALTER DATABASE "anchorclaw-memory" OWNER TO "anchorclaw"');
  });

  it("fails fast when schema has conflicting tables but no schema_migrations", async () => {
    pgState.dbExists = true;
    pgState.userExists = true;
    pgState.tableRows = [{ table_name: "memory_items" }];

    await expect(
      runAnchorClawSetup({
        nonInteractive: true,
        skipConfig: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      }),
    ).rejects.toThrow(/Refusing to proceed/);
  });

  it("fails fast when managed schema tables are owned by another role", async () => {
    pgState.dbExists = true;
    pgState.userExists = true;
    pgState.tableRows = [{ table_name: "schema_migrations" }];
    pgState.tableOwnerRows = [
      { table_name: "memory_items", table_owner: "anchorclaw_phase4_smoke" },
      { table_name: "memory_audit_log", table_owner: "anchorclaw_phase4_smoke" },
    ];

    await expect(
      runAnchorClawSetup({
        nonInteractive: true,
        skipConfig: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "openclaw",
        dbPassword: "secret",
        schema: "memory",
      }),
    ).rejects.toThrow(/contains existing tables owned by another role/);
  });

  it("applies database/schema ownership and create grants for runtime user", async () => {
    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw",
      dbUser: "anchorclaw",
      dbPassword: "secret",
      schema: "memory",
    });

    const allSql = pgState.clients.flatMap((c) => c.queries.map((q) => q.text)).join("\n");
    expect(allSql).toContain('ALTER DATABASE "anchorclaw" OWNER TO "anchorclaw"');
    expect(allSql).toContain('GRANT CREATE ON DATABASE "anchorclaw" TO "anchorclaw"');
    expect(allSql).toContain('CREATE SCHEMA IF NOT EXISTS "memory" AUTHORIZATION "anchorclaw"');
    expect(allSql).toContain('ALTER SCHEMA "memory" OWNER TO "anchorclaw"');
  });

  it("does not rotate password for an existing user by default", async () => {
    pgState.dbExists = true;
    pgState.userExists = true;

    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw",
      dbUser: "anchorclaw_existing",
      dbPassword: "secret",
      schema: "memory",
    });

    const allSql = pgState.clients.flatMap((c) => c.queries.map((q) => q.text)).join("\n");
    expect(allSql).not.toContain('ALTER USER "anchorclaw_existing" WITH PASSWORD');
  });

  it("rotates password for an existing user only when explicitly enabled", async () => {
    pgState.dbExists = true;
    pgState.userExists = true;

    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw",
      dbUser: "anchorclaw_existing",
      dbPassword: "secret",
      rotateDbPassword: true,
      schema: "memory",
    });

    const allSql = pgState.clients.flatMap((c) => c.queries.map((q) => q.text)).join("\n");
    expect(allSql).toContain('ALTER USER "anchorclaw_existing" WITH PASSWORD');
  });

  it("writes postgres and maintenance config into openclaw.json", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.slots.memory).toBe("anchorclaw");
      expect(cfg.plugins.entries.anchorclaw.enabled).toBe(true);
      expect(cfg.plugins.entries.anchorclaw.config.postgres.password).toBe("secret");
      expect(cfg.plugins.entries.anchorclaw.config.maintenance).toEqual({
        enabled: true,
        dryRun: false,
        intervalMinutes: 720,
        batchSize: 200,
        workspaceScope: {
          mode: "default-agent",
        },
        extractor: {
          enabled: true,
          maxCandidates: 10,
          maxCharsPerRun: 12000,
        },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes semantic enablement and defaults memorySearch from non-interactive flags", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
        semanticEnabled: true,
        semanticProvider: "openai-compatible",
        semanticModel: "text-embedding-3-small",
        semanticBaseUrl: "http://127.0.0.1:1234/v1",
        semanticApiKey: "${ANCHORCLAW_EMBED_API_KEY}",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.semantic).toEqual({ enabled: true });
      expect(cfg.agents.defaults.memorySearch).toEqual({
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: "${ANCHORCLAW_EMBED_API_KEY}",
        },
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("- semantic: enabled");
      expect(consoleLogSpy).toHaveBeenCalledWith("- memorySearch provider: openai-compatible");
      expect(consoleLogSpy).toHaveBeenCalledWith("- memorySearch model: text-embedding-3-small");
      expect(consoleLogSpy).toHaveBeenCalledWith("- memorySearch apiKey: configured");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "- semantic schema: prepared; migrations apply on gateway startup",
      );

      const targetSql = pgState.clients
        .filter((client) => client.connectionString.endsWith("/anchorclaw"))
        .flatMap((client) => client.queries.map((query) => query.text))
        .join("\n");
      expect(targetSql).toContain('SET search_path TO "memory", public');
      expect(targetSql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
      expect(targetSql).not.toContain("CREATE TABLE IF NOT EXISTS semantic_schema_migrations");
      expect(targetSql).not.toContain("CREATE TABLE IF NOT EXISTS memory_item_embeddings");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("merges semantic setup with existing defaults memorySearch and preserves per-agent overrides", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai-compatible",
                model: "old-model",
                remote: {
                  baseUrl: "http://127.0.0.1:1234/v1",
                  apiKey: { env: "OLD_EMBED_API_KEY" },
                },
              },
            },
            list: [
              {
                id: "ops",
                memorySearch: {
                  provider: "custom-provider",
                  model: "ops-model",
                },
              },
            ],
          },
          plugins: {
            entries: {
              anchorclaw: {
                config: {
                  semantic: {
                    enabled: true,
                  },
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
        semanticModel: "new-model",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.semantic).toEqual({ enabled: true });
      expect(cfg.agents.defaults.memorySearch).toEqual({
        provider: "openai-compatible",
        model: "new-model",
        remote: {
          baseUrl: "http://127.0.0.1:1234/v1",
          apiKey: { env: "OLD_EMBED_API_KEY" },
        },
      });
      expect(cfg.agents.list[0].memorySearch).toEqual({
        provider: "custom-provider",
        model: "ops-model",
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("- memorySearch apiKey: configured");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "- semantic schema: prepared; migrations apply on gateway startup",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails when semantic is enabled non-interactively without provider/model after merge", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      await expect(
        runAnchorClawSetup({
          nonInteractive: true,
          adminUrl: "postgres://localhost/postgres",
          dbName: "anchorclaw",
          dbUser: "anchorclaw",
          dbPassword: "secret",
          schema: "memory",
          maintenanceWorkspaceScope: "default-agent",
          semanticEnabled: true,
        }),
      ).rejects.toThrow(
        "semantic setup requires agents.defaults.memorySearch.provider or --semantic-provider when semantic is enabled",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails when semantic flags are used with skip-config", async () => {
    await expect(
      runAnchorClawSetup({
        nonInteractive: true,
        skipConfig: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        semanticEnabled: true,
        semanticProvider: "openai-compatible",
        semanticModel: "text-embedding-3-small",
      }),
    ).rejects.toThrow("semantic setup options require config update; remove semantic flags or omit --skip-config");
  });

  it("disables bundled session-memory hook while preserving its config", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          hooks: {
            internal: {
              entries: {
                "session-memory": {
                  enabled: true,
                  llmSlug: "existing-slug",
                },
              },
            },
          },
          plugins: {},
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.hooks.internal.entries["session-memory"].enabled).toBe(false);
      expect(cfg.hooks.internal.entries["session-memory"].llmSlug).toBe("existing-slug");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "- bundled session-memory hook: disabled for DB-backed /new and /reset daily capture",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not overwrite config password for an existing user when password rotation is disabled", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      pgState.dbExists = true;
      pgState.userExists = true;
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              anchorclaw: {
                config: {
                  postgres: {
                    password: "existing-secret",
                  },
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "new-secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.postgres.password).toBe("existing-secret");
      expect(cfg.plugins.entries.anchorclaw.config.postgres.user).toBe("anchorclaw");
      expect(cfg.plugins.entries.anchorclaw.config.postgres.database).toBe("anchorclaw");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enables hooks.allowPromptInjection automatically during config update", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              anchorclaw: {
                hooks: {
                  allowPromptInjection: false,
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.hooks.allowPromptInjection).toBe(true);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "- hooks.allowPromptInjection: enabled for DB-backed daily startup injection",
      );
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("enables maintenance/extractor defaults and rewrites extractor config from supported fields only", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              anchorclaw: {
                config: {
                  maintenance: {
                    intervalMinutes: 360,
                    batchSize: 50,
                    extractor: {
                      agentId: "worker-a",
                      maxCandidates: 8,
                    },
                  },
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        maintenanceWorkspaceScope: "default-agent",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.maintenance).toEqual({
        enabled: true,
        dryRun: false,
        intervalMinutes: 360,
        batchSize: 50,
        workspaceScope: {
          mode: "default-agent",
        },
        extractor: {
          enabled: true,
          maxCandidates: 8,
          maxCharsPerRun: 12000,
        },
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not ask an extra prompt-injection question in interactive mode", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              anchorclaw: {
                hooks: {
                  allowPromptInjection: false,
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      readlineState.answers = [
        "", // admin url
        "", // db name
        "", // db user
        "", // schema
        "", // password
        "", // update config -> default yes
        "", // semantic -> default no
        "", // maintenance scope -> default first choice
      ];

      await runAnchorClawSetup({
        nonInteractive: false,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.hooks.allowPromptInjection).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("disables maintenance entirely when selected during interactive setup", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      readlineState.answers = [
        "", // admin url
        "", // db name
        "", // db user
        "", // schema
        "", // password
        "", // update config -> default yes
        "", // semantic -> default no
        "2", // maintenance scope -> disable maintenance
        "", // rotate existing user password -> default no
      ];

      await runAnchorClawSetup({
        nonInteractive: false,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.maintenance).toEqual({
        enabled: false,
        dryRun: false,
        intervalMinutes: 720,
        batchSize: 200,
        extractor: {
          enabled: false,
          maxCandidates: 10,
          maxCharsPerRun: 12000,
        },
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("- maintenance: disabled");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves an existing maintenance workspace scope in non-interactive setup", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          plugins: {
            entries: {
              anchorclaw: {
                config: {
                  maintenance: {
                    workspaceScope: {
                      mode: "all-agent-workspaces",
                    },
                  },
                },
              },
            },
          },
        }, null, 2) + "\n",
      );

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.maintenance.workspaceScope).toEqual({
        mode: "all-agent-workspaces",
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("- maintenance extractor scope: all-agent-workspaces");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("fails in non-interactive setup when maintenance scope is missing and config update is enabled", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      await expect(
        runAnchorClawSetup({
          nonInteractive: true,
          adminUrl: "postgres://localhost/postgres",
          dbName: "anchorclaw",
          dbUser: "anchorclaw",
          dbPassword: "secret",
          schema: "memory",
        }),
      ).rejects.toThrow(
        'maintenance workspace scope is required for non-interactive setup because setup enables extractor by default; pass --maintenance-workspace-scope "default-agent" or "all-agent-workspaces", preconfigure maintenance.workspaceScope, or use --skip-config',
      );

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg).toEqual({ plugins: {} });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses existing defaults as interactive semantic prompt defaults and lets Enter keep them", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai-compatible",
                model: "text-embedding-3-small",
                remote: {
                  baseUrl: "http://127.0.0.1:1234/v1",
                },
              },
            },
          },
          plugins: {},
        }, null, 2) + "\n",
      );

      readlineState.answers = [
        "", // admin url
        "", // db name
        "", // db user
        "", // schema
        "", // password
        "", // update config -> default yes
        "y", // semantic -> enable
        "", // provider -> keep existing
        "", // model -> keep existing
        "", // baseUrl -> keep existing
        "", // apiKey -> keep/skip
        "", // maintenance scope -> default first choice
      ];

      await runAnchorClawSetup({
        nonInteractive: false,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.semantic).toEqual({ enabled: true });
      expect(cfg.agents.defaults.memorySearch).toEqual({
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "http://127.0.0.1:1234/v1",
        },
      });
      expect(consoleLogSpy).toHaveBeenCalledWith("- semantic: enabled");
      expect(consoleLogSpy).toHaveBeenCalledWith("- memorySearch apiKey: not configured");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousOpenClawHome === undefined) {
        delete process.env.OPENCLAW_HOME;
      } else {
        process.env.OPENCLAW_HOME = previousOpenClawHome;
      }
      if (previousConfigPath === undefined) {
        delete process.env.OPENCLAW_CONFIG_PATH;
      } else {
        process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
      }
      if (previousConfigDir === undefined) {
        delete process.env.OPENCLAW_CONFIG_DIR;
      } else {
        process.env.OPENCLAW_CONFIG_DIR = previousConfigDir;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

});
