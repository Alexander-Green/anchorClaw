# AnchorClaw Installation and Configuration

This guide keeps the operator details out of the main README. Start with
[README.md](./README.md) if you want the product overview first.

## Prerequisites

- OpenClaw host `>= 2026.5.12` with memory plugin slots
- Node.js for the plugin runtime
- PostgreSQL

AnchorClaw does not require embeddings for the MVP.

## Basic Install

Install the plugin:

```bash
openclaw plugins install @alexandrgreen/anchorclaw
```

Provision Postgres and write the required OpenClaw config:

```bash
openclaw anchorclaw setup
```

Restart the gateway:

```bash
openclaw gateway restart
```

## What Setup Writes

By default, setup updates `~/.openclaw/openclaw.json` with:

- `plugins.slots.memory = "anchorclaw"`
- `plugins.entries.anchorclaw.enabled = true`
- `plugins.entries.anchorclaw.config.postgres`
- `plugins.entries.anchorclaw.config.workspaceDir`
- `plugins.entries.anchorclaw.hooks.allowPromptInjection = true`
- `hooks.internal.entries["session-memory"].enabled = false`

Setup preserves unrelated top-level `anchorclaw.config` keys such as
`identity`, `sessions`, `maintenance`, and `limits`.

Setup rewrites `anchorclaw.config.postgres`; if you use SSL or custom pool
settings, add those overrides after setup.

Setup does not mutate `<workspaceDir>/AGENTS.md`. Existing OpenClaw instructions
that mention `MEMORY.md` or `memory/YYYY-MM-DD.md` remain compatible through
AnchorClaw's runtime/tool layer.

## Workspace Rule

`workspaceDir` is AnchorClaw's source of truth for workspace scoping, legacy
import scans, prompt cache, and DB-backed `memory/*` compatibility reads.

Setup accepts `--workspace-dir`; otherwise it uses `OPENCLAW_WORKSPACE_DIR` when
present, then the OpenClaw default workspace path. If config update is enabled
and no workspace path can be resolved, setup fails fast instead of writing a
partial config.

Current operational rule: the live agent workspace should match AnchorClaw
`workspaceDir`. If they diverge, runtime paths such as `/new` and `/reset` can
write into a different DB workspace scope than import, search, and store paths.

## Skip Config Mode

If you run setup with `--skip-config`, add this manually to
`~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  }
}
```

Leaving the bundled file-based `session-memory` hook enabled can create active
Markdown daily files plus DB daily entries for the same reset context.

## Legacy Import

Setup does not auto-import existing workspace memory files. It leaves them
untouched and lets the operator review the migration.

Dry-run the current workspace state:

```bash
openclaw anchorclaw import
```

Apply the migration:

```bash
openclaw anchorclaw import --apply
```

What `--apply` does:

- imports `MEMORY.md` into Postgres durable memory (`memory_items`);
- backs up `MEMORY.md` to `.openclaw-repair/anchorclaw/`;
- replaces `MEMORY.md` with an HTML-comment-only stub;
- imports `memory/YYYY-MM-DD.md` files into DB daily entries
  (`memory_daily_entries`);
- archives imported daily files out of the active `memory/` directory into
  `.openclaw-repair/anchorclaw/legacy-daily/`.

Daily files are archived instead of left active because legacy file-oriented
instructions may keep treating them as active memory. That can cause duplicate
prompt injection or repeated durable promotion.

Escape hatch:

```bash
openclaw anchorclaw import --apply --keep-files
```

`--keep-files` is only for exceptional situations. It leaves active legacy files
in place and can reintroduce duplicate prompt injection risk.

## CLI Setup Details

By default, setup runs in interactive mode and prompts for:

- Postgres admin URL
- database name
- app user
- schema name (`none` uses the default PostgreSQL `search_path`)
- app password, or auto-generate
- whether to update `~/.openclaw/openclaw.json`
- workspace directory when config update is enabled

Non-interactive example:

```bash
openclaw anchorclaw setup \
  --admin-url postgres://postgres:password@localhost/postgres \
  --db-name anchorclaw \
  --db-user anchorclaw \
  --schema memory \
  --non-interactive
```

Useful flags:

- `--skip-config`: keep `~/.openclaw/openclaw.json` unchanged
- `--schema-none`: use PostgreSQL default `search_path`
- `--db-password <pass>`: set app user password explicitly

Defaults when omitted:

- `--admin-url`: `postgres://localhost/postgres`
- `--db-name`: `anchorclaw`
- `--db-user`: `anchorclaw`
- `--db-password`: auto-generated
- `--schema`: `memory`
- config update: enabled

Safety behavior:

- idempotent setup for existing database, user, and schema;
- no destructive operations on existing databases or schemas;
- fail-fast on schema conflicts that look AnchorClaw-related but have no
  `schema_migrations`.

## Common Config Overrides

For Docker, production, or non-default behavior, merge the relevant overrides
into `plugins.entries.anchorclaw.config`.

```json
{
  "identity": {
    "externalId": "family-main-01"
  },
  "sessions": {
    "search": {
      "enabled": false
    },
    "visibility": "current",
    "sync": {
      "deltaBytes": 100000,
      "deltaMessages": 50
    }
  },
  "maintenance": {
    "enabled": true,
    "dryRun": false,
    "intervalMinutes": 720,
    "batchSize": 200,
    "extractor": {
      "enabled": true,
      "maxCandidates": 10,
      "maxCharsPerRun": 12000
    }
  },
  "limits": {
    "maxResults": 10,
    "getMaxChars": 12000,
    "getDefaultLines": 120
  }
}
```

`sessions.search.enabled` controls whether the sessions corpus is exposed.
`sessions.visibility` controls which transcript updates can enter the sessions
index:

- `current`: index only the current agent/session scope;
- `visible`: accept visible cross-agent transcript updates;
- `off`: disable sessions indexing/listener behavior.

`sessions.sync.deltaBytes` and `sessions.sync.deltaMessages` control when
transcript deltas trigger a targeted sessions reindex.

`maintenance.enabled` starts the background maintenance scheduler. The
maintenance extractor reads bounded DB daily windows and can promote durable
candidates into `memory_items`; current setup writes the release-aligned
`memory_log`-only lane by default.

`maintenance.dryRun=false` enables real durable promotion. `dryRun=true`
reports heuristic candidate counts only and is useful as a conservative
fallback for partial/manual configs.

`limits` can reduce search/read caps below the built-in maximums.

## Identity and Workspace Scoping

AnchorClaw scopes reads and writes by `(user_id, workspace_id)`.

Preferred identity for Docker and production:

```json
{
  "plugins": {
    "entries": {
      "anchorclaw": {
        "config": {
          "workspaceDir": "/root/.openclaw/workspace",
          "identity": {
            "externalId": "family-main-01"
          }
        }
      }
    }
  }
}
```

If `identity.externalId` is not configured, AnchorClaw derives identity from the
normalized OS username. That is convenient for development, but multiple people
sharing the same OS user account will share the same AnchorClaw `user_id`.

AnchorClaw logs a startup warning when fallback identity is active.

Workspace identity is isolated per user and per resolved workspace directory
(`dir:<sha256(resolved workspaceDir)>`).

## Postgres SSL

AnchorClaw supports two mutually exclusive SSL styles:

- simple flag: `postgres.ssl: true|false`
- explicit mode: `postgres.sslMode: "disable"|"require"|"verify-full"` plus
  optional `postgres.sslCa`

Strict certificate verification example:

```json
{
  "postgres": {
    "host": "db.example.com",
    "port": "${PGPORT}",
    "database": "anchorclaw",
    "user": "anchorclaw",
    "password": "${ANCHORCLAW_DB_PASSWORD}",
    "sslMode": "verify-full",
    "sslCa": "${ANCHORCLAW_DB_SSL_CA_PEM}"
  }
}
```

`postgres.ssl` and `postgres.sslMode` cannot be set at the same time.

## Postgres Pool

Optional pool tuning:

```json
{
  "postgres": {
    "host": "localhost",
    "database": "anchorclaw",
    "schema": "memory",
    "user": "postgres",
    "pool": {
      "max": 10,
      "connectionTimeoutMs": 5000,
      "idleTimeoutMs": 30000
    }
  }
}
```

Defaults:

- `postgres.port`: `5432`
- `postgres.schema`: optional; when omitted, AnchorClaw uses the default
  PostgreSQL `search_path`
- `postgres.pool.max`: `10`
- `postgres.pool.connectionTimeoutMs`: `5000`
- `postgres.pool.idleTimeoutMs`: `30000`
- `sessions.sync.deltaBytes`: `100000`
- `sessions.sync.deltaMessages`: `50`

`postgres.schema` is strongly recommended for production to isolate AnchorClaw
tables from shared `public` schema objects.

## Manual Postgres Setup

If you prefer manual provisioning:

```sql
CREATE DATABASE anchorclaw;
CREATE USER anchorclaw WITH PASSWORD 'change-me';
GRANT CONNECT ON DATABASE anchorclaw TO anchorclaw;
```

Then connect to `anchorclaw` and run:

```sql
CREATE SCHEMA IF NOT EXISTS memory AUTHORIZATION anchorclaw;
GRANT USAGE, CREATE ON SCHEMA memory TO anchorclaw;
ALTER DEFAULT PRIVILEGES IN SCHEMA memory GRANT ALL ON TABLES TO anchorclaw;
ALTER DEFAULT PRIVILEGES IN SCHEMA memory GRANT ALL ON SEQUENCES TO anchorclaw;
```

After that, configure the plugin `postgres` fields in `openclaw.json` and
restart the gateway.
