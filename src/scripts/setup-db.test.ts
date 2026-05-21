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

import { patchWorkspaceAgentsInstructions, runAnchorClawSetup } from "./setup-db.js";

describe("runAnchorClawSetup", () => {
  const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  beforeEach(() => {
    readlineState.answers = [];
    pgState.clients = [];
    pgState.tableRows = [];
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

  it("backs up AGENTS.md before removing known OpenClaw file-memory instructions", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const originalAgents = [
      "# AGENTS.md - Your Workspace",
      "",
      "## Memory",
      "",
      "You wake up fresh each session. These files are your continuity:",
      "",
      "- **Daily notes:** `memory/YYYY-MM-DD.md`",
      "- **Long-term:** `MEMORY.md`",
      "",
      "### MEMORY.md - Your Long-Term Memory",
      "",
      "- You can **read, edit, and update** MEMORY.md freely in main sessions",
      "",
      "### Write It Down - No \"Mental Notes\"!",
      "",
      "- When someone says \"remember this\" -> update `memory/YYYY-MM-DD.md` or relevant file",
      "",
      "## Red Lines",
      "",
      "- Don't run destructive commands without asking.",
      "",
      "## Heartbeats - Be Proactive!",
      "",
      "**Proactive work you can do without asking:**",
      "",
      "- Read and organize memory files",
      "- **Review and update MEMORY.md** (see below)",
      "",
      "### Memory Maintenance (During Heartbeats)",
      "",
      "Periodically (every few days), use a heartbeat to:",
      "",
      "1. Read through recent `memory/YYYY-MM-DD.md` files",
      "2. Identify significant events, lessons, or insights worth keeping long-term",
      "3. Update `MEMORY.md` with distilled learnings",
      "",
      "The goal: Be helpful without being annoying.",
      "",
    ].join("\n");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");
      writeFileSync(agentsPath, originalAgents);

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        workspaceDir,
        patchAgents: true,
      });

      const patchedAgents = readFileSync(agentsPath, "utf-8");
      expect(patchedAgents).not.toContain("## Memory");
      expect(patchedAgents).not.toContain("Review and update MEMORY.md");
      expect(patchedAgents).not.toContain("Memory Maintenance (During Heartbeats)");
      expect(patchedAgents).toContain("## Red Lines");
      expect(patchedAgents).toContain("The goal: Be helpful without being annoying.");

      const backupDir = join(workspaceDir, ".openclaw-repair", "anchorclaw");
      const backups = readdirSync(backupDir).filter((name) => name.startsWith("AGENTS.md.anchorclaw-backup."));
      expect(backups).toHaveLength(1);
      const backup = readFileSync(join(backupDir, backups[0]!), "utf-8");
      expect(backup).toBe(originalAgents);
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

  it("does not patch custom AGENTS.md memory sections that do not match known OpenClaw defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const workspaceDir = resolve(home, "workspace");
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const customAgents = [
      "# AGENTS.md",
      "",
      "## Memory",
      "",
      "This section is custom and should stay intact.",
      "",
      "## Red Lines",
      "",
      "Keep it simple.",
      "",
    ].join("\n");

    try {
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(agentsPath, customAgents);

      const result = patchWorkspaceAgentsInstructions({ workspaceDir });

      expect(result.status).toBe("unchanged");
      expect(readFileSync(agentsPath, "utf-8")).toBe(customAgents);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not remove the MEMORY.md review bullet from unrelated custom AGENTS.md sections", () => {
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const workspaceDir = resolve(home, "workspace");
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const customAgents = [
      "# AGENTS.md",
      "",
      "## Heartbeats",
      "",
      "- **Review and update MEMORY.md** (see below)",
      "",
      "This is a custom workflow note and should stay intact.",
      "",
    ].join("\n");

    try {
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(agentsPath, customAgents);

      const result = patchWorkspaceAgentsInstructions({ workspaceDir });

      expect(result.status).toBe("unchanged");
      expect(readFileSync(agentsPath, "utf-8")).toBe(customAgents);
    } finally {
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

  it("leaves AGENTS.md unchanged by default in interactive setup", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const originalAgents = [
      "# AGENTS.md - Your Workspace",
      "",
      "## Memory",
      "",
      "- **Long-term:** `MEMORY.md`",
      "",
      "## Red Lines",
      "",
      "## Heartbeats - Be Proactive!",
      "",
      "- **Review and update MEMORY.md** (see below)",
      "",
      "### Memory Maintenance (During Heartbeats)",
      "",
      "The goal: Be helpful without being annoying.",
      "",
    ].join("\n");
    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");
      writeFileSync(agentsPath, originalAgents);

      readlineState.answers = [
        "", // admin url
        "", // db name
        "", // db user
        "", // schema
        "", // password
        "", // workspace dir
        "", // update config -> default yes
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

      const agentsAfter = readFileSync(agentsPath, "utf-8");
      expect(agentsAfter).toBe(originalAgents);

      const backupDir = join(workspaceDir, ".openclaw-repair", "anchorclaw");
      expect(() => readdirSync(backupDir)).toThrow();
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

  it("does not patch AGENTS.md by default in non-interactive setup", async () => {
    const previousHome = process.env.HOME;
    const previousOpenClawHome = process.env.OPENCLAW_HOME;
    const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    const previousConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    const home = mkdtempSync(join(tmpdir(), "anchorclaw-setup-"));
    const configDir = join(home, ".openclaw");
    const configPath = join(configDir, "openclaw.json");
    const workspaceDir = resolve(home, "workspace");
    const agentsPath = join(workspaceDir, "AGENTS.md");
    const originalAgents = [
      "# AGENTS.md - Your Workspace",
      "",
      "## Memory",
      "",
      "- **Long-term:** `MEMORY.md`",
      "",
      "## Red Lines",
      "",
    ].join("\n");

    try {
      process.env.HOME = home;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.OPENCLAW_CONFIG_DIR;
      mkdirSync(configDir, { recursive: true });
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ plugins: {} }, null, 2) + "\n");
      writeFileSync(agentsPath, originalAgents);

      await runAnchorClawSetup({
        nonInteractive: true,
        adminUrl: "postgres://localhost/postgres",
        dbName: "anchorclaw",
        dbUser: "anchorclaw",
        dbPassword: "secret",
        schema: "memory",
        workspaceDir,
      });

      expect(readFileSync(agentsPath, "utf-8")).toBe(originalAgents);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "- AGENTS.md patch: not requested (use --patch-agents if legacy file-memory instructions conflict)",
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
});
