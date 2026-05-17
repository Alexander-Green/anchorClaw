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

### 2) Configure

Select the memory slot and configure Postgres:

```json
{
  "plugins": {
    "slots": { "memory": "anchorclaw" },
    "entries": {
      "anchorclaw": {
        "enabled": true,
        "config": {
          "sessions": {
            "visibility": "current",
            "sync": {
              "deltaBytes": 100000,
              "deltaMessages": 50
            }
          },
          "identity": {
            "externalId": "family-main-01"
          },
          "postgres": {
            "host": "localhost",
            "database": "anchorclaw",
            "schema": "memory",
            "user": "postgres",
            "password": "${ANCHORCLAW_DB_PASSWORD}"
          }
        }
      }
    }
  }
}
```

### 3) Restart

```bash
openclaw gateway restart
```

---

## Recommended DB Setup (Automatic)

AnchorClaw now supports explicit setup via CLI:

```bash
openclaw anchorclaw setup
```

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

Defaults (when omitted):

- `--admin-url`: `postgres://localhost/postgres`
- `--db-name`: `anchorclaw`
- `--db-user`: `anchorclaw`
- `--db-password`: auto-generated
- `--schema`: `memory`
- config update: enabled by default

Safety behavior:

- idempotent setup for existing database/user/schema
- no destructive operations on existing databases/schemas
- fail-fast on schema conflicts that look AnchorClaw-related but have no `schema_migrations`

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
