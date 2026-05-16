import { describe, expect, it, vi, beforeEach } from "vitest";

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

import { runAnchorClawSetup } from "./setup-db.js";

describe("runAnchorClawSetup", () => {
  beforeEach(() => {
    pgState.clients = [];
    pgState.tableRows = [];
    pgState.dbExists = false;
    pgState.userExists = false;
  });

  it("supports no-schema fallback without schema SQL", async () => {
    await runAnchorClawSetup({
      nonInteractive: true,
      skipConfig: true,
      adminUrl: "postgres://localhost/postgres",
      dbName: "anchorclaw",
      dbUser: "anchorclaw",
      dbPassword: "secret",
      noSchema: true,
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
});

