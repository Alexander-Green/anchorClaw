<p align="center">
  <img src="./assets/logo.png" alt="AnchorClaw logo" width="800" height="600" style="display:block;margin:0 auto" />
</p>

# AnchorClaw — Postgres Memory Plugin (OpenClaw)

> Alpha preview. API may change before stable release.

**AnchorClaw** is created and maintained by Alexander Green.
The canonical repository is https://github.com/Alexander-Green/anchorClaw.

**AnchorClaw** is an OpenClaw memory plugin that replaces file-based durable memory (`MEMORY.md`) with a Postgres-backed, SQL-first durable store while keeping OpenClaw’s memory tooling and CLI/doctor/status flows compatible.

This package currently targets a **Track A core runtime** release:

- durable memory is DB-backed
- daily memory is DB-owned and injected on first-turn/new-session
- sessions search exists as an explicit opt-in
- maintenance/extractor remains experimental but now runs from DB daily windows when enabled
- backend extractor transport uses host-owned `api.runtime.llm.complete`

## Why We Built This

OpenClaw’s default memory model is excellent for transparency (plain files) but it becomes harder to:

- do deterministic retrieval and updates (avoid duplicates, enforce stable ordering)
- support multi-user/workspace isolation cleanly
- evolve toward advanced features (semantic recall, personas, episodes, knowledge graphs) without turning memory into an opaque blob

AnchorClaw makes **Postgres the source of truth** for durable memory while preserving OpenClaw’s UX expectations (tools, corpuses, `MEMORY.md` compatibility).

## What Works Today (Track A Core)

- **Durable memory in Postgres** (`memory_items`):
  - `memory_store` (canonical upsert via `canonicalKey`; use when the user's intent is to persist information for future interactions)
  - `memory_search` (`corpus="memory"`) via Postgres FTS over durable memory plus DB-owned daily memory
  - `memory_get` reads synthetic paths (`db-memory/items/<uuid>.md`) with bounded excerpts
  - `memory_forget` soft-deletes items (+ audit trail in DB)
- **DB-owned daily memory** (`memory_daily_entries`):
  - `memory_log` appends transient daily context into canonical `memory/YYYY-MM-DD.md` entries backed by Postgres
  - `memory_get("memory/YYYY-MM-DD.md")` is DB-first
  - daily startup injection happens on first-turn/new-session via hook-based prompt injection, with OpenClaw-compatible recent-daily limits
- **OpenClaw compatibility**
  - `registerMemoryCapability` + a `MemorySearchManager` adapter so `status/doctor/CLI` can work
  - `memory_get` accepts both parameter styles:
    - AnchorClaw-native: `{ lookup, fromLine, lineCount }`
    - OpenClaw aliases: `{ path, from, lines }`
  - Reading `MEMORY.md` via `memory_get`/runtime returns a **virtual snapshot generated from Postgres** (keeps legacy flows compatible while DB stays source-of-truth)
- **Sessions corpus (opt-in)**
  - `memory_search(corpus="sessions")` uses Postgres-backed sessions index (`session_index_files` + `session_index_chunks`) with FTS ranking
  - disabled by default unless `sessions.search.enabled=true`
  - `memory_get(path="sessions/<agentId>/<file>")` is DB-first; file fallback is used only on `index_miss`
  - `sessions.visibility` modes: `off | current | visible` (default scope filter: `current`)
  - `sessions.sync.deltaBytes` / `sessions.sync.deltaMessages` control delta reindex thresholds (defaults: `100000` / `50`)
  - state/session path resolution follows OpenClaw-compatible order: `OPENCLAW_STATE_DIR` -> `OPENCLAW_HOME/.openclaw` (or `HOME/.openclaw`) -> legacy `HOME/.clawdbot`
  - Phase 2 live/delta indexing is enabled (`onSessionTranscriptUpdate` + debounce + targeted sync)
  - visibility behavior is runtime-verified:
    - `current`: cross-agent delta updates are ignored
    - `visible`: cross-agent delta updates are accepted and indexed
    - `off`: sessions delta listener is disabled
- **Migration support**
  - Explicit operator CLI for one-time or repair-style legacy import/backfill
  - `MEMORY.md` is imported into Postgres durable memory, then backed up and stubbed
  - `memory/YYYY-MM-DD.md` files are imported into DB daily entries, then archived out of the active workspace path
- **Phase 4 maintenance foundation (backend-owned, still evolving)**
  - Optional background maintenance scheduler (`maintenance.enabled`)
  - DB-owned cycle over `memory_daily_entries` windows with `dryRun` support
  - Extractor + dedupe checks before write into `memory_items`
  - Extractor uses host-owned `api.runtime.llm.complete` instead of plugin-side shell execution
  - Records processed daily windows in `memory_daily_extraction_windows` only after successful extractor cycle
  - Non-dry-run maintenance waits for durable startup state to become `ready`
  - `dryRun` reports heuristic candidate counts only; it does not run the extractor
  - Legacy `memory_episodic` runtime scaffold is removed from the active path and dropped by cleanup migration

---

## 🛠 Prerequisites

- OpenClaw host `>= 2026.5.12` that supports memory plugin slots
  (see `package.json` → `openclaw.install.minHostVersion`)
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
- `hooks.internal.entries["session-memory"].enabled = false`

`workspaceDir` is AnchorClaw's source of truth for workspace scoping, legacy import scans, prompt cache, and DB-backed `memory/*` compatibility reads. Setup accepts `--workspace-dir`; otherwise it uses `OPENCLAW_WORKSPACE_DIR` when present, then the OpenClaw default workspace path. If config update is enabled and no workspace path can be resolved, setup fails fast instead of writing a partial config.

Current operational rule: agent workspaces should match AnchorClaw `workspaceDir`.
If a live agent runs in a different workspace, runtime paths such as `/new` and
`/reset` can write into a different DB workspace scope than import/search/store
paths.

Setup does **not** need to mutate `<workspaceDir>/AGENTS.md`. Default OpenClaw instructions that mention `MEMORY.md` or `memory/YYYY-MM-DD.md` remain compatible: when AnchorClaw is active, the runtime prompt and tool schemas map those concepts to DB-backed `memory_store`, `memory_log`, `memory_search`, and `memory_get`.

Setup disables OpenClaw's bundled file-based `session-memory` hook because AnchorClaw captures `/new` and `/reset` session summaries into DB-backed daily memory. Leaving both enabled can create active Markdown daily files plus DB daily entries for the same reset context.

If you run setup with `--skip-config`, add this manually to `~/.openclaw/openclaw.json`:

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

If legacy memory files already exist in the workspace, setup leaves them untouched. After setup, review and migrate them with:

```bash
openclaw anchorclaw import
openclaw anchorclaw import --apply
```

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

`sessions.search.enabled` controls whether the sessions corpus is exposed at all. `sessions.visibility` then controls which transcript updates can enter the sessions index:

- `current` (default scope filter): index only the current agent/session scope; cross-agent delta updates are ignored
- `visible`: accept visible cross-agent transcript updates
- `off`: disable sessions indexing/listener behavior

`sessions.sync.deltaBytes` and `sessions.sync.deltaMessages` control when transcript deltas trigger a
targeted sessions reindex. Track A runtime daily memory is owned by `memory_daily_entries`; the maintenance
extractor now reads bounded DB daily windows and promotes durable candidates into `memory_items`, but this path
is still considered experimental while we tune windowing and operator validation.
`limits` can reduce search/read caps below the built-in maximums. `maintenance.dryRun` currently reports
heuristic candidate counts only; it is meant for cheap backlog visibility, not extractor-faithful validation.

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

## Community Integrations

Community-maintained integration notes live under `docs/integrations/`.

- [TweetClaw source memory workflow](docs/integrations/tweetclaw.md) - contributed by the TweetClaw/Xquik
  community. TweetClaw and Xquik are maintained separately from AnchorClaw.

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
- `--schema-none`: use PostgreSQL default `search_path` (no dedicated schema)
- `--db-password <pass>`: set app user password explicitly
- `--enable-prompt-injection`: automatically set `plugins.entries.anchorclaw.hooks.allowPromptInjection=true`

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
- disables bundled `hooks.internal.entries["session-memory"]` so `/new` and `/reset` daily capture stays DB-backed
- preserves unrelated top-level `anchorclaw.config` keys such as `identity`, `sessions`, `maintenance`, and `limits`
- rewrites `anchorclaw.config.postgres`; re-add `postgres.sslMode`, `postgres.sslCa`, or `postgres.pool` after setup if you use them
- leaves `AGENTS.md` unchanged; legacy file-memory instructions are handled through AnchorClaw runtime/tool compatibility
- fails fast if config update is enabled but `workspaceDir` cannot be resolved

Safety behavior:

- idempotent setup for existing database/user/schema
- no destructive operations on existing databases/schemas
- fail-fast on schema conflicts that look AnchorClaw-related but have no `schema_migrations`

---

## Memory Tooling (Track A Core)

AnchorClaw exposes both “native” and compatibility surfaces via OpenClaw tool contracts:

- `memory_store({ content, canonicalKey?, type? })` where `type` is `fact|note` (MVP)
  - use for durable facts/preferences/recurring schedules/decisions/settings/project rules/curated notes when the user's intent is persistence across future interactions
  - if the intended memory lifetime is ambiguous, ask a brief clarification before storing
- `memory_log({ content, date?, path? })`
  - use for current-day/current-conversation context, events, meeting notes, and temporary daily notes that would normally go to `memory/YYYY-MM-DD.md`
- `memory_search({ query, corpus?, maxResults?, minScore? })`
  - `corpus="memory"` (default): Postgres durable memory plus DB-owned daily memory
  - `corpus="daily"`: DB-owned daily memory only
  - `corpus="sessions"`: Postgres sessions index (DB-first, opt-in)
  - `corpus="all"`: deterministic merge of durable memory + DB-owned daily memory + sessions only when sessions search is enabled
  - `corpus="wiki"`: stub for now (use `wiki_search/wiki_get` from `memory-wiki`)
- `memory_get({ lookup|path, fromLine|from?, lineCount|lines? })`
  - `MEMORY.md` is a virtual DB snapshot (source-of-truth is Postgres)
- `memory_forget({ lookup|path? , id? })`
- `memory_status({ check? })`
  - default (`check` omitted / `false`): cached runtime degraded-state report
  - active mode (`check: true`): lightweight healthcheck for DB connectivity/schema + sessions dir accessibility (`exists` + explicit `readable` check), plus legacy import diagnostics

---

## Legacy Import and File Handling

Track B moves legacy migration out of startup and setup. AnchorClaw does not auto-import workspace files on boot; instead it scans for active legacy files and warns the operator when import is pending.

Dry-run the current workspace state:

```bash
openclaw anchorclaw import
```

Apply the migration:

```bash
openclaw anchorclaw import --apply
```

What `--apply` does:

- `MEMORY.md` -> import into Postgres durable memory (`memory_items`)
- `MEMORY.md` -> backup to `.openclaw-repair/anchorclaw/`
- `MEMORY.md` -> replace with an HTML-comment-only stub
- `memory/YYYY-MM-DD.md` -> import into DB daily entries (`memory_daily_entries`)
- `memory/YYYY-MM-DD.md` -> archive out of the active `memory/` directory into `.openclaw-repair/anchorclaw/legacy-daily/`

Why the daily files are archived instead of left in place:

- leaving them in `memory/` allows legacy file-oriented instructions to keep treating them as active daily memory
- that can lead to duplicate prompt injection or repeated promotion into durable memory
- archiving preserves the original files without keeping them on the active runtime path

Escape hatch:

```bash
openclaw anchorclaw import --apply --keep-files
```

`--keep-files` is only for exceptional situations. It leaves active legacy files in place and can reintroduce duplicate prompt injection risk.

### `AGENTS.md` Compatibility

AnchorClaw does not require rewriting workspace instructions. Existing OpenClaw-style instructions can keep referring to `MEMORY.md` and `memory/YYYY-MM-DD.md`; AnchorClaw treats those as memory concepts backed by Postgres tools:

- `MEMORY.md` writes/search/reads map to `memory_store`, `memory_search`, and `memory_get("MEMORY.md")`
- `memory/YYYY-MM-DD.md` appends/reads map to `memory_log` and `memory_get("memory/YYYY-MM-DD.md")`

Direct edits to those files should only happen when the user explicitly asks for file editing or export.

---

## Defaults

- `postgres.port`: `5432`
- `postgres.schema`: optional; when omitted, AnchorClaw uses the default PostgreSQL `search_path` (commonly `"$user", public`)
- `postgres.pool.max`: `10`
- `postgres.pool.connectionTimeoutMs`: `5000`
- `postgres.pool.idleTimeoutMs`: `30000`
- `sessions.sync.deltaBytes`: `100000` (OpenClaw-compatible default)
- `sessions.sync.deltaMessages`: `50` (OpenClaw-compatible default)

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
