# AnchorClaw Installation and Configuration

This guide keeps the operator details out of the main README. Start with
[README.md](./README.md) if you want the product overview first.

> Upgrade notice for configs created before `0.0.9`:
> `maintenance.extractor.agentId` and
> `plugins.entries.anchorclaw.config.workspaceDir` were removed starting in
> `0.0.9`.
> AnchorClaw uses an explicit multi-agent workspace model, so runtime
> scope comes from OpenClaw agent context instead of one global plugin
> workspace key.
> See [ARCHITECTURE.md#multi-agent-workspace-model](./ARCHITECTURE.md#multi-agent-workspace-model).

## Prerequisites

- OpenClaw host `>= 2026.5.28` with memory plugin slots
- Node.js for the plugin runtime
- PostgreSQL

AnchorClaw does not require embeddings for its core runtime.
The runtime path remains SQL/FTS-first; the optional semantic layer enriches
durable memory search and falls back to lexical retrieval if embeddings are
missing or unavailable.

## Basic Install

Install the plugin:

```bash
openclaw plugins install clawhub:@alexandrgreen/anchorclaw
```

Use `npm:@alexandrgreen/anchorclaw` if you explicitly need the npm fallback.

Verify that AnchorClaw is active as the memory slot owner:

```bash
openclaw plugins inspect anchorclaw
```

If the plugin is installed but not active, enable it:

```bash
openclaw plugins enable anchorclaw
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
- `plugins.entries.anchorclaw.hooks.allowPromptInjection = true`
- `plugins.entries.anchorclaw.hooks.allowConversationAccess = true`
- `hooks.internal.entries["session-memory"].enabled = false`

Setup preserves unrelated top-level `anchorclaw.config` keys such as
`identity`, `sessions`, and `limits`. It updates the `maintenance` enablement,
workspace scope, and extractor enablement selected during setup while
preserving existing interval, batch, and extractor limit overrides.

When semantic is enabled during setup, setup also writes:

- `plugins.entries.anchorclaw.config.semantic.enabled = true`
- `agents.defaults.memorySearch`

Setup installs the PostgreSQL `vector` extension with the admin connection.
After the gateway restart, AnchorClaw applies the semantic table migrations with
the configured app user, so the app user owns the AnchorClaw tables. This keeps
the semantic path consistent with normal runtime migrations and does not require
setup to rotate or re-enter an existing app password.

Setup treats the selected database as an AnchorClaw application database. It
sets the app user as database owner and grants the privileges needed for runtime
migrations. Use a dedicated database rather than pointing setup at a shared
application database whose ownership must remain unchanged.

Setup manages only `agents.defaults.memorySearch`. Existing
per-agent `agents.list[].memorySearch` overrides are preserved as-is.

Setup rewrites `anchorclaw.config.postgres`; if you use SSL or custom pool
settings, add those overrides after setup.

Setup does not mutate workspace `AGENTS.md`. Existing OpenClaw instructions
that mention `MEMORY.md` or `memory/YYYY-MM-DD.md` remain compatible through
AnchorClaw's runtime/tool layer.

## Upgrading

Run this after every OpenClaw or AnchorClaw upgrade, then restart the gateway:

```bash
openclaw anchorclaw update
openclaw gateway restart
```

`update` reconciles the last three settings in the list above and reports each
change. It is idempotent, it never connects to PostgreSQL, and it leaves the
Postgres, maintenance, extractor, and semantic sections untouched. Use
`--dry-run` to preview.

Prefer `update` over re-running `setup` on an existing install: `setup` always
opens an admin connection to PostgreSQL, and its interactive defaults can
re-enable a maintenance scheduler you deliberately turned off.

### Why This Is Required From OpenClaw 2026.7.2-beta.6

That release added `before_prompt_build` to the host's `CONVERSATION_HOOK_NAMES`
set. The current stable `latest` (`2026.7.1-2`) does not have it yet, so this
affects the beta channel today and the stable channel once the `2026.7.2` line
ships. From then on the host refuses to register the hook for any non-bundled
plugin, AnchorClaw included, unless the plugin entry explicitly sets:

```json
{
  "plugins": {
    "entries": {
      "anchorclaw": {
        "hooks": { "allowConversationAccess": true }
      }
    }
  }
}
```

The host records the refusal as a registry diagnostic only. Nothing fails
loudly: the plugin still loads, the tools still work, and only the automatic
injection of durable and daily memory into the prompt goes away. Older hosts
ignore the flag, so setting it is safe in both directions.

When AnchorClaw detects this state it warns in the gateway log at startup,
reports `daily.startupPromptEffective: false` from `memory_status`, and tells
the agent through the memory capability, which the host does not gate.

To inspect the host's own view of the refusal:

```bash
openclaw plugins doctor
```

## Skip Config Mode

`--skip-config` means setup provisions PostgreSQL only. It does not select the
memory slot, enable the plugin, write the Postgres or semantic config, enable
prompt injection, or disable OpenClaw's bundled file-based session-memory hook.
The operator must manage all of those OpenClaw settings manually.

In particular, add this hook override to `~/.openclaw/openclaw.json`:

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

Legacy files remain on disk until the operator applies the import, but
AnchorClaw does not use them as a runtime fallback. `memory/*` compatibility
reads are DB-only, so unimported files are not visible through `memory_get`.

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
- imports `memory/YYYY-MM-DD.md` files into the DB daily projection
  (`memory_daily_entries`) and immutable append ledger
  (`memory_daily_blocks`);
- archives imported daily files out of the active `memory/` directory into
  `.openclaw-repair/anchorclaw/legacy-daily/`.

If one or more legacy daily files fail to import, the command reports
`incomplete`, prints the failed daily count, and exits with an error after the
target report instead of claiming a clean success.

Daily files are archived instead of left active because legacy file-oriented
instructions may keep treating them as active memory. That can cause duplicate
prompt injection or repeated durable promotion.

Escape hatch:

```bash
openclaw anchorclaw import --apply --keep-files
```

`--keep-files` is only for exceptional situations. It leaves active legacy files
in place and can reintroduce duplicate prompt injection risk.

Import target selection:

- `--default-agent`: import into the resolved default agent workspace
- `--agent <id>`: import into one specific configured agent workspace
- `--all-agent-workspaces`: import every unique workspace from `agents.list`
- `--source-dir <path>`: override where legacy files are read from; this does
  not replace target selection

Examples:

```bash
openclaw anchorclaw import --default-agent
openclaw anchorclaw import --agent ops
openclaw anchorclaw import --all-agent-workspaces
openclaw anchorclaw import --source-dir /path/to/legacy --default-agent
```

## CLI Setup Details

By default, setup runs in interactive mode and prompts for:

- Postgres admin URL
- database name
- app user
- schema name (`none` uses the default PostgreSQL `search_path`)
- app password, or auto-generate
- whether to update `~/.openclaw/openclaw.json`
- whether to enable the AnchorClaw semantic layer
- if semantic is enabled: `provider`, `model`, optional `baseUrl`, and optional
  `apiKey`, using existing `agents.defaults.memorySearch` values as prompt
  defaults when present
- which resolved workspace scope maintenance and the extractor should process,
  or whether background maintenance should remain disabled
- when an app password was entered and the app user already exists, whether to
  rotate that user's password

Non-interactive example:

```bash
openclaw anchorclaw setup \
  --admin-url postgres://postgres:password@localhost/postgres \
  --db-name anchorclaw \
  --db-user anchorclaw \
  --schema memory \
  --maintenance-workspace-scope default-agent \
  --non-interactive
```

Non-interactive semantic example:

```bash
openclaw anchorclaw setup \
  --admin-url postgres://postgres:password@localhost/postgres \
  --db-name anchorclaw \
  --db-user anchorclaw \
  --schema memory \
  --maintenance-workspace-scope default-agent \
  --semantic-enabled \
  --semantic-provider openai-compatible \
  --semantic-model text-embedding-3-small \
  --semantic-base-url http://127.0.0.1:1234/v1 \
  --non-interactive
```

When `setup --non-interactive` updates `~/.openclaw/openclaw.json`, it must
know what maintenance workspace scope to write.

Use `--maintenance-workspace-scope default-agent` for the normal single-agent or
implicit-main case.

Use `--maintenance-workspace-scope all-agent-workspaces` when maintenance should
cover every unique configured workspace from `agents.list`.

For selected-agent maintenance, preconfigure `maintenance.workspaceScope` with
`mode: "agents"` and an explicit `agents` list. Setup preserves that existing
config value, but `--maintenance-workspace-scope` does not create selected-agent
scopes.

If `maintenance.workspaceScope` is already present in config, the flag can be
omitted and setup preserves the existing value.

If you only want to create/update the database objects and do not want setup to
touch config, use `--skip-config --non-interactive`.

If config update is enabled and no maintenance scope is available from either
the flag or existing config, setup fails fast instead of guessing.

Semantic merge rules:

- `--semantic-enabled` turns on
  `plugins.entries.anchorclaw.config.semantic.enabled`;
- semantic flags write only `agents.defaults.memorySearch`;
- if a semantic flag is omitted, setup reuses the existing
  `agents.defaults.memorySearch` value;
- if a semantic flag is provided, it overrides the existing default value;
- after merge, `provider` and `model` must exist or setup fails fast;
- `baseUrl` is optional;
- `apiKey` is optional and is reported only as `configured` or
  `not configured` in setup output;
- existing `memorySearch` config does not auto-enable AnchorClaw semantic by
  itself;
- semantic flags require config update and are not compatible with `--skip-config`.

Useful flags:

- `--skip-config`: keep `~/.openclaw/openclaw.json` unchanged
- `--schema-none`: use PostgreSQL default `search_path`
- `--db-password <pass>`: set the password for a new app user, or provide the
  replacement value used together with `--rotate-db-password`
- `--rotate-db-password`: allow setup to replace an existing app user's password
  and update the managed OpenClaw Postgres config with that value
- `--maintenance-workspace-scope <mode>`: write maintenance scope into config;
  supported values are `default-agent` and `all-agent-workspaces`
- `--semantic-enabled`: enable `plugins.entries.anchorclaw.config.semantic.enabled`
- `--semantic-provider <id>`: set `agents.defaults.memorySearch.provider`
- `--semantic-model <model>`: set `agents.defaults.memorySearch.model`
- `--semantic-base-url <url>`: set
  `agents.defaults.memorySearch.remote.baseUrl`
- `--semantic-api-key <value>`: set
  `agents.defaults.memorySearch.remote.apiKey`

Defaults when omitted:

- `--admin-url`: `postgres://localhost/postgres`
- `--db-name`: `anchorclaw`
- `--db-user`: `anchorclaw`
- `--db-password`: auto-generated for a new app user; an existing user's password
  is preserved unless `--rotate-db-password` is passed
- `--schema`: `memory`
- config update: enabled

Safety behavior:

- idempotent setup for existing database, user, and schema;
- no database, schema, or table drops;
- the selected database is assigned to the configured app user and receives the
  grants required for runtime migrations;
- an existing app user's password and the corresponding config value are left
  unchanged unless password rotation is explicitly requested;
- fail-fast on schema conflicts that look AnchorClaw-related but have no
  `schema_migrations`.

## Upgrade an Existing SQL-Only Installation to Semantic

An existing SQL/FTS-only installation does not need a new database or a full
reinstall. Rerun setup against the same dedicated database and enable semantic:

```bash
openclaw anchorclaw setup \
  --admin-url postgres://postgres:password@localhost/postgres \
  --db-name anchorclaw \
  --db-user anchorclaw \
  --schema memory \
  --semantic-enabled \
  --semantic-provider openai-compatible \
  --semantic-model text-embedding-3-small \
  --semantic-base-url http://127.0.0.1:1234/v1 \
  --non-interactive
```

The existing `maintenance.workspaceScope` is preserved when the scope flag is
omitted. If the old config has no scope, add either
`--maintenance-workspace-scope default-agent` or
`--maintenance-workspace-scope all-agent-workspaces` explicitly.

For an existing app user, setup preserves its database password and leaves the
password already present in `openclaw.json` unchanged. If that password is
missing or must change, either update the Postgres config yourself or explicitly
pass both `--db-password <value>` and `--rotate-db-password`.

Setup provisions the `vector` extension and writes semantic config. Restart the
gateway afterwards; runtime then applies the separate semantic migrations using
the configured app-user connection. Existing durable items remain valid and
their derived embeddings are filled on demand and through maintenance.

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
    "workspaceScope": {
      "mode": "default-agent"
    },
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

Semantic opt-in example:

```json
{
  "plugins": {
    "entries": {
      "anchorclaw": {
        "config": {
          "semantic": {
            "enabled": true
          }
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai-compatible",
        "model": "text-embedding-3-small",
        "remote": {
          "baseUrl": "http://127.0.0.1:1234/v1"
        }
      }
    }
  }
}
```

Do not enable the semantic config by hand without provisioning `vector` first.
Run `openclaw anchorclaw setup --semantic-enabled ...` and restart the gateway.
If the runtime finds semantic config without a ready extension or schema, it
keeps lexical SQL/FTS retrieval available and reports the semantic problem in
`memory_status` and logs.

Current boundary:

- setup enables the optional semantic layer, writes its OpenClaw config, and
  provisions the PostgreSQL `vector` extension with admin privileges; the
  restarted gateway then applies the separate semantic schema as the app user;
- durable `memory_items` use hybrid SQL/FTS + vector retrieval when the active
  OpenClaw agent has a resolvable `memorySearch` provider/model;
- daily memory and sessions remain lexical in this slice;
- missing/stale embeddings are built on demand: search tries a small inline
  batch first, then queues bounded maintenance indexing when backlog remains;
- queued semantic indexing is drained in the background only while
  `maintenance.enabled=true` and `maintenance.dryRun=false`; lexical search
  remains available while embeddings are pending;
- if semantic provider/schema/runtime is unavailable, AnchorClaw keeps lexical
  SQL/FTS retrieval working and reports the semantic problem in
  `memory_status`, tool details, or logs.

On OpenClaw versions older than `2026.8.1-beta.1`,
`sessions.search.enabled` controls whether AnchorClaw's legacy sessions corpus
is exposed. `sessions.visibility` controls which indexed transcripts an agent
can search and read:

- `current`: allow indexed sessions owned by the requesting agent;
- `visible`: also expose sessions of agents that share the same resolved
  workspace;
- `off`: disable sessions indexing/listener behavior.

This AnchorClaw scope is an upper bound, not a replacement for OpenClaw's
session-tools security policy. Final access is the intersection with
`tools.sessions.visibility` and, for another agent, `tools.agentToAgent`. On
OpenClaw `2026.5.28`, the host default is `tree`, so an unrelated prior session
of the same agent can still be hidden. Set `tools.sessions.visibility: "agent"`
when every session owned by that agent should be searchable. Cross-agent access
with AnchorClaw `visible` additionally requires host visibility `all` and an
allowing agent-to-agent policy; the shared-workspace restriction still applies.

`sessions.sync.deltaBytes` and `sessions.sync.deltaMessages` control when
transcript deltas trigger a targeted sessions reindex. Transcript events are
always routed to the workspace resolved for their owning OpenClaw agent.

On OpenClaw `>=2026.8.1-beta.1`, these legacy settings are accepted for config
compatibility but AnchorClaw does not crawl or index active transcripts, and
does not map `sessions.visibility` onto the host policy. Use OpenClaw's native
`sessions_search` and `sessions_history` tools instead; their access is
controlled solely by `tools.sessions.visibility` (default: `tree`).

`maintenance.enabled` starts the background maintenance scheduler. The
required `maintenance.workspaceScope` selects which resolved OpenClaw
workspace or workspaces it processes. The example above uses the default agent;
use `all-agent-workspaces` to process every unique configured workspace.
The maintenance extractor reads stable, versioned windows from immutable
`memory_log` daily blocks and can promote durable candidates into
`memory_items`. `maintenance.extractor.maxCharsPerRun` controls how many stable
windows fit into one LLM call; changing it does not make completed blocks
pending again.

Setup enables maintenance and the extractor with `dryRun=false` when a workspace
scope is selected. New eligible `memory_log` windows can therefore produce LLM
extractor calls on the configured interval. Choose `disable maintenance` during
interactive setup, or set `maintenance.enabled=false`, if those background calls
are not wanted yet. Completed extraction windows are recorded and are not sent
again solely because another scheduler interval elapsed.

Daily content is passed to the extractor as explicitly delimited untrusted
data, separate from the system extraction policy. This is defence in depth
against prompt injection; operators should still treat automatic promotion as
an LLM-mediated path and keep normal database backups and audit review.

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

Workspace identity is isolated per user and per resolved agent workspace path.

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
CREATE USER anchorclaw WITH PASSWORD 'change-me';
CREATE DATABASE anchorclaw OWNER anchorclaw;
GRANT CONNECT, CREATE ON DATABASE anchorclaw TO anchorclaw;
```

Then connect to `anchorclaw` and run:

```sql
CREATE SCHEMA IF NOT EXISTS memory AUTHORIZATION anchorclaw;
GRANT USAGE, CREATE ON SCHEMA memory TO anchorclaw;
ALTER DEFAULT PRIVILEGES IN SCHEMA memory GRANT ALL ON TABLES TO anchorclaw;
ALTER DEFAULT PRIVILEGES IN SCHEMA memory GRANT ALL ON SEQUENCES TO anchorclaw;
```

For semantic retrieval, a PostgreSQL administrator must also run this in the
`anchorclaw` database before semantic config is enabled:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

The app user can then apply both the base and semantic AnchorClaw table
migrations when the gateway starts. If you manually provision an existing
database instead of creating a dedicated one, make sure the app user has the
same ownership and `CREATE` privileges without changing ownership that other
applications rely on.

After that, configure the plugin `postgres` fields in `openclaw.json` and
restart the gateway.
