<p align="center">
  <img src="./assets/logo.png" alt="AnchorClaw logo" width="800" height="600" style="display:block;margin:0 auto" />
</p>

# AnchorClaw — Postgres Memory Plugin (OpenClaw)

> Alpha preview. API may change before stable release.

**AnchorClaw** is created and maintained by Alexander Green.
The canonical repository is https://github.com/Alexander-Green/anchorClaw.

**AnchorClaw** is an OpenClaw memory plugin that replaces file-based durable memory (`MEMORY.md`) with a Postgres-backed, SQL-first durable store while keeping OpenClaw’s memory tooling and CLI/doctor/status flows compatible.

## Why We Built This

OpenClaw’s default memory model is excellent for transparency (plain files) but it becomes harder to:

- do deterministic retrieval and updates (avoid duplicates, enforce stable ordering)
- support multi-user/workspace isolation cleanly
- evolve toward advanced features (semantic recall, personas, episodes, knowledge graphs) without turning memory into an opaque blob

AnchorClaw makes **Postgres the source of truth** for durable memory while preserving OpenClaw’s UX expectations (tools, corpuses, `MEMORY.md` compatibility).

## What Works Today (MVP)

- **Durable memory in Postgres** (`memory_items`):
  - `memory_store` (canonical upsert via `canonicalKey`)
  - `memory_search` (`corpus="memory"`) via Postgres FTS (deterministic ordering)
  - `memory_get` reads synthetic paths (`db-memory/items/<uuid>.md`) with bounded excerpts
  - `memory_forget` soft-deletes items (+ audit trail in DB)
  - `memory_recall` shortcut (query → search; empty query → top items)
- **OpenClaw compatibility**
  - `registerMemoryCapability` + a `MemorySearchManager` adapter so `status/doctor/CLI` can work
  - `memory_get` accepts both parameter styles:
    - AnchorClaw-native: `{ lookup, fromLine, lineCount }`
    - OpenClaw aliases: `{ path, from, lines }`
  - Reading `MEMORY.md` via `memory_get`/runtime returns a **virtual snapshot generated from Postgres** (keeps legacy flows compatible while DB stays source-of-truth)
- **Sessions corpus (Phase 1 + Phase 2 live-pass complete)**
  - `memory_search(corpus="sessions")` uses Postgres-backed sessions index (`session_index_files` + `session_index_chunks`) with FTS ranking
  - `memory_get(path="sessions/<agentId>/<file>")` is DB-first; file fallback is used only on `index_miss`
  - `sessions.visibility` modes: `off | current | visible` (default: `current`)
  - `sessions.sync.deltaBytes` / `sessions.sync.deltaMessages` control delta reindex thresholds (defaults: `100000` / `50`)
  - state/session path resolution follows OpenClaw-compatible order: `OPENCLAW_STATE_DIR` -> `OPENCLAW_HOME/.openclaw` (or `HOME/.openclaw`) -> legacy `HOME/.clawdbot`
  - Phase 2 live/delta indexing is enabled (`onSessionTranscriptUpdate` + debounce + targeted sync)
  - visibility behavior is runtime-verified:
    - `current`: cross-agent delta updates are ignored
    - `visible`: cross-agent delta updates are accepted and indexed
    - `off`: sessions delta listener is disabled
- **Migration support**
  - One-time idempotent import of legacy `MEMORY.md` into Postgres (by file hash)
  - Optional (default on) cleanup of `MEMORY.md` after import to avoid duplicate prompt injection
- **Phase 4 maintenance foundation (backend-owned)**
  - Optional background maintenance scheduler (`maintenance.enabled`)
  - DB-owned cycle over `memory_episodic` with `dryRun` support
  - Extractor + dedupe checks before write into `memory_items`
  - Archives processed episodic rows only after successful extractor cycle
  - Non-dry-run maintenance waits for durable startup state to become `ready`
  - `dryRun` reports heuristic candidate counts only; it does not run the extractor

---

## 🛠 Prerequisites

- OpenClaw host that supports memory plugin slots (see `package.json` → `openclaw.install.minHostVersion`)
- Node.js (plugin runtime)
- PostgreSQL (no embeddings required for MVP)

---

## 🚀 Quick Start

### 1) Install

```bash
openclaw plugins install @alexandrgreen/anchorclaw
```

### 2) Provision Postgres and write required config

```bash
openclaw anchorclaw setup
```

By default, setup updates `~/.openclaw/openclaw.json` with the required runtime config:

- `plugins.slots.memory = "anchorclaw"`
- `plugins.entries.anchorclaw.enabled = true`
- `plugins.entries.anchorclaw.config.postgres` (`host`, `port`, `database`, `schema`, `user`, `password`)
- `plugins.entries.anchorclaw.config.workspaceDir`

`workspaceDir` is AnchorClaw's source of truth for startup import, workspace scoping, prompt cache, and `memory/*` reads. Setup accepts `--workspace-dir`; otherwise it uses `OPENCLAW_WORKSPACE_DIR` when present, then the OpenClaw default workspace path. If config update is enabled and no workspace path can be resolved, setup fails fast instead of writing a partial config.

When setup successfully updates OpenClaw config, it also checks `<workspaceDir>/AGENTS.md` for the known default OpenClaw file-memory instructions that tell agents to write durable memory into `MEMORY.md`. If found, setup writes a backup first, then removes only those known default instruction blocks so AnchorClaw remains the single durable memory writer.

### 3) Optional config overrides

For Docker/production or non-default behavior, merge the relevant overrides into the existing
`plugins.entries.anchorclaw.config` object written by setup.

Common overrides:

```json
{
  "identity": {
    "externalId": "family-main-01"
  },
  "sessions": {
    "visibility": "current",
    "sync": {
      "deltaBytes": 100000,
      "deltaMessages": 50
    }
  },
  "import": {
    "cleanupMemoryMdAfterImport": true
  },
  "maintenance": {
    "enabled": false,
    "dryRun": true,
    "intervalMinutes": 720,
    "batchSize": 200,
    "extractor": {
      "enabled": false,
      "agentId": "main",
      "maxCandidates": 20,
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

`sessions.visibility` controls which transcript updates can enter the sessions index:

- `current` (default): index only the current agent/session scope; cross-agent delta updates are ignored
- `visible`: accept visible cross-agent transcript updates
- `off`: disable sessions indexing/listener behavior

`sessions.sync.deltaBytes` and `sessions.sync.deltaMessages` control when transcript deltas trigger a
targeted sessions reindex. `import.cleanupMemoryMdAfterImport` controls the default post-import `MEMORY.md`
stub cleanup. AnchorClaw maintenance source is episodic events (`memory_episodic`), and `limits` can reduce search/read caps below the built-in maximums.
`maintenance.dryRun` currently reports heuristic candidate counts only; it is meant for cheap backlog visibility, not extractor-faithful validation.

Optional Postgres runtime settings belong inside the existing `postgres` block. Setup writes the required
connection fields; add these only when needed:

```json
{
  "sslMode": "verify-full",
  "sslCa": "${ANCHORCLAW_DB_SSL_CA_PEM}",
  "pool": {
    "max": 10,
    "connectionTimeoutMs": 5000,
    "idleTimeoutMs": 30000
  }
}
```

The setup command rewrites `anchorclaw.config.postgres`; add SSL or pool overrides after setup if you use them.

### 4) Restart

```bash
openclaw gateway restart
```

---

## CLI DB Setup Details

AnchorClaw supports explicit setup via CLI:

```bash
openclaw anchorclaw setup
```

By default this runs in interactive mode. It prompts for:

- Postgres admin URL
- database name
- app user
- schema name (`none` uses the default PostgreSQL `search_path`)
- app password (or auto-generate)
- whether to update `~/.openclaw/openclaw.json`
- workspace directory when config update is enabled
- whether to patch workspace `AGENTS.md` and remove known default `MEMORY.md` writer instructions (asked only when config update is enabled)

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
- `--skip-agents-patch`: do not patch workspace `AGENTS.md`
- `--schema-none`: use PostgreSQL default `search_path` (no dedicated schema)
- `--db-password <pass>`: set app user password explicitly

Defaults (when omitted):

- `--admin-url`: `postgres://localhost/postgres`
- `--db-name`: `anchorclaw`
- `--db-user`: `anchorclaw`
- `--db-password`: auto-generated
- `--schema`: `memory`
- config update: enabled by default

Config update behavior:

- writes `plugins.slots.memory = "anchorclaw"` even if install already selected the memory slot
- writes `plugins.entries.anchorclaw.enabled = true`
- writes the required `postgres` connection block
- preserves unrelated top-level `anchorclaw.config` keys such as `identity`, `sessions`, `import`, and `limits`
- rewrites `anchorclaw.config.postgres`; re-add `postgres.sslMode`, `postgres.sslCa`, or `postgres.pool` after setup if you use them
- when config update succeeds, patches known default `AGENTS.md` file-memory instructions unless `--skip-agents-patch` is used
- fails fast if config update is enabled but `workspaceDir` cannot be resolved

Safety behavior:

- idempotent setup for existing database/user/schema
- no destructive operations on existing databases/schemas
- fail-fast on schema conflicts that look AnchorClaw-related but have no `schema_migrations`
- before patching `AGENTS.md`, writes a backup under `.openclaw-repair/anchorclaw/`

---

## Memory Tooling (MVP)

AnchorClaw exposes both “native” and compatibility surfaces via OpenClaw tool contracts:

- `memory_store({ content, canonicalKey?, type? })` where `type` is `fact|note` (MVP)
- `memory_search({ query, corpus?, maxResults?, minScore? })`
  - `corpus="memory"` (default): Postgres durable memory
  - `corpus="sessions"`: Postgres sessions index (DB-first)
  - `corpus="all"`: deterministic merge of `memory + sessions`
  - `corpus="wiki"`: stub for now (use `wiki_search/wiki_get` from `memory-wiki`)
- `memory_get({ lookup|path, fromLine|from?, lineCount|lines? })`
  - `MEMORY.md` is a virtual DB snapshot (source-of-truth is Postgres)
- `memory_forget({ lookup|path? , id? })`
- `memory_recall({ query? })`
- `memory_status({ check? })`
  - default (`check` omitted / `false`): cached runtime degraded-state report
  - active mode (`check: true`): lightweight healthcheck for DB connectivity/schema + sessions dir accessibility (`exists` + explicit `readable` check)

---

## Importing `MEMORY.md` and Avoiding Duplicate Prompt Memory

OpenClaw core injects `MEMORY.md` as a bootstrap file. AnchorClaw also injects Postgres-backed durable memory via its memory capability.

To avoid duplicated prompt memory, AnchorClaw **cleans up `MEMORY.md` after a successful import by default**:

- backup: `.openclaw-repair/anchorclaw/MEMORY.md.anchorclaw-backup.<timestamp>.md`
- replacement: `MEMORY.md` becomes an HTML-comment-only stub

To disable cleanup:

```json
{ "import": { "cleanupMemoryMdAfterImport": false } }
```

### Workspace `AGENTS.md` Patch

OpenClaw's default workspace `AGENTS.md` tells agents to maintain durable memory by editing `MEMORY.md`. With AnchorClaw enabled, that instruction creates a second writer path and can lead to split-brain memory.

During setup, AnchorClaw therefore performs a narrow patch of the configured workspace `AGENTS.md`:

- backs up the original file to `.openclaw-repair/anchorclaw/AGENTS.md.anchorclaw-backup.<timestamp>.md`
- removes the known default `## Memory` file-memory section only when the expected OpenClaw markers are present
- removes the known heartbeat `Memory Maintenance (During Heartbeats)` subsection only when the expected OpenClaw markers are present
- removes the known proactive-work bullet that says to review/update `MEMORY.md`

If you later uninstall or disable AnchorClaw and want to return to OpenClaw's file-based memory workflow, restore those instructions from the backup file or from OpenClaw's default `AGENTS.md` template.

Note for uninstall/disable: after removing AnchorClaw, restore the removed `AGENTS.md` memory-maintenance block from `.openclaw-repair/anchorclaw/AGENTS.md.anchorclaw-backup.<timestamp>.md` so default OpenClaw file-memory behavior works as expected.

---

## Defaults

- `postgres.port`: `5432`
- `postgres.schema`: optional; when omitted, AnchorClaw uses the default PostgreSQL `search_path` (commonly `"$user", public`)
- `postgres.pool.max`: `10`
- `postgres.pool.connectionTimeoutMs`: `5000`
- `postgres.pool.idleTimeoutMs`: `30000`
- `sessions.sync.deltaBytes`: `100000` (OpenClaw-compatible default)
- `sessions.sync.deltaMessages`: `50` (OpenClaw-compatible default)
- Import cleanup: `import.cleanupMemoryMdAfterImport = true`

---

## Identity & Workspace Scoping (MVP)

AnchorClaw scopes all reads/writes by `(user_id, workspace_id)` derived from the current runtime identity.

- Preferred identity (Docker/production): set `identity.externalId` (max 20 chars). This becomes the stable `user_identities` key (`channel=anchorclaw-config`).
- Fallback identity (dev convenience): if `identity.externalId` is not set, identity is derived from OS username (`external_id = sha256(normalized username)`, `channel=openclaw-cli`).
  - If multiple people share the same OS user account, they will share the same AnchorClaw `user_id`.
  - AnchorClaw logs a startup warning on every start when fallback mode is active.
- Workspace identity: workspaces are isolated per user and per workspace directory (`workspace name = dir:<sha256(resolved workspaceDir)>`).

Recommended for Docker/production:

```json
{
  "plugins": {
    "entries": {
      "anchorclaw": {
        "config": {
          "workspaceDir": "/root/.openclaw/workspace",
          "identity": { "externalId": "family-main-01" }
        }
      }
    }
  }
}
```

---

## Postgres SSL

AnchorClaw supports two mutually exclusive SSL configuration styles:

- Simple flag: `postgres.ssl: true|false`
- Explicit mode: `postgres.sslMode: "disable"|"require"|"verify-full"` (+ optional `postgres.sslCa`)

If you need strict certificate verification (recommended for production), use:

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

---

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

`postgres.schema` is strongly recommended for production to isolate AnchorClaw tables from shared `public` schema objects.

---

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

After that configure plugin `postgres` fields in `openclaw.json` and restart gateway.

---

## Roadmap (Planned)

AnchorClaw intentionally starts with deterministic SQL-first durability. Next layers are planned to reach PostClaw parity and beyond:

- **Semantic layer**: embeddings + semantic search (hybrid retrieval: lexical + vector; optional and non-breaking)
- **Persona context in DB**: dynamic persona/profile retrieval and injection into the system prompt (separate budgets/policy)
- **Knowledge graph**: `entity_edges`-style relationships and multi-hop retrieval to pull secondary context automatically
- **Wiki integration / AnchorClaw-native wiki**: either integrate OpenClaw supplements (`memory-wiki`) or build a DB-native wiki layer

## Current Status

- Durable memory MVP: implemented and green in repo tests.
- Sessions Phase 1 and Phase 2: implemented, reviewed, and runtime-verified on VPS `server-166`.
- Session delta indexing parity path is active in runtime (listener + debounce + targeted sync + lifecycle cleanup compatibility fallback).
