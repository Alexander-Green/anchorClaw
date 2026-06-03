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

  it("writes workspaceDir into openclaw config from explicit setup option", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
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
        workspaceDir,
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.slots.memory).toBe("anchorclaw");
      expect(cfg.plugins.entries.anchorclaw.enabled).toBe(true);
      expect(cfg.plugins.entries.anchorclaw.config.workspaceDir).toBe(workspaceDir);
      expect(cfg.plugins.entries.anchorclaw.config.postgres.password).toBe("secret");
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

  it("disables bundled session-memory hook while preserving its config", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
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
        workspaceDir,
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
    const workspaceDir = resolve(home, "workspace");
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
        workspaceDir,
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

  it("enables hooks.allowPromptInjection when explicitly requested", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
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
        workspaceDir,
        enablePromptInjection: true,
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

  it("warns in non-interactive mode when hooks.allowPromptInjection stays disabled", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
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
        workspaceDir,
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Warning: hooks.allowPromptInjection is false in openclaw.json.",
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Warning: AnchorClaw daily startup injection will stay degraded until prompt injection is enabled.",
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Warning: Re-run `openclaw anchorclaw setup --enable-prompt-injection` to enable it automatically.",
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

  it("uses OPENCLAW_WORKSPACE_DIR as setup config fallback", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const previousWorkspace = process.env.OPENCLAW_WORKSPACE_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "env-workspace");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir;
      mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
      });

      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(cfg.plugins.entries.anchorclaw.config.workspaceDir).toBe(workspaceDir);
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
      if (previousWorkspace === undefined) {
        delete process.env.OPENCLAW_WORKSPACE_DIR;
      } else {
        process.env.OPENCLAW_WORKSPACE_DIR = previousWorkspace;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("asks to enable prompt injection only when config explicitly disables it", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
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
        "", // workspace dir
        "", // update config -> default yes
        "", // enable prompt injection -> default yes
      ];

      await runAnchorClawSetup({
        nonInteractive: false,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        workspaceDir,
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

});
