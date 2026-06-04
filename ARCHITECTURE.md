# AnchorClaw Architecture

AnchorClaw is a SQL-first memory layer for OpenClaw. It makes PostgreSQL the
source of truth for durable and daily memory while preserving OpenClaw's memory
tooling, CLI/status/doctor flows, and legacy `MEMORY.md` expectations.

## Design Principles

- **Database first**: durable memory, daily memory, import state, session index
  state, and maintenance progress live in Postgres.
- **Compatibility second**: OpenClaw-facing tools and file-like paths remain
  available, but they resolve through AnchorClaw's DB-backed layer.
- **Deterministic before semantic**: canonical upserts, full-text search, stable
  ordering, and auditability ship before embeddings.
- **Semantics as enrichment**: embeddings, persona, episodes, and knowledge
  graph features should enrich the SQL source of truth rather than replace it.
- **Operator visibility**: setup, import, status, and maintenance are explicit
  operator surfaces, not hidden prompt behavior.

## Runtime Contract

Active tools:

- `memory_store`: writes durable memory only.
- `memory_log`: writes daily/current context only.
- `memory_search`: searches durable memory plus DB-owned daily memory by
  default.
- `memory_get`: reads DB-backed synthetic paths, virtual `MEMORY.md`, and
  DB-backed daily paths.
- `memory_forget`: soft-deletes durable items.
- `memory_status`: reports runtime and operator diagnostics.

Corpus behavior:

- `memory_search()` and `memory_search(corpus="memory")` search durable memory
  plus DB-owned daily memory.
- `memory_search(corpus="daily")` searches only daily memory.
- `memory_search(corpus="sessions")` works only when
  `sessions.search.enabled=true`.
- `memory_search(corpus="all")` adds sessions only when sessions search is
  explicitly enabled.
- `corpus="wiki"` is a stub for now; use the `memory-wiki` integration where
  available.

Read behavior:

- `memory_get("MEMORY.md")` returns a virtual snapshot generated from
  Postgres.
- `memory_get("memory/YYYY-MM-DD.md")` resolves DB-first.
- `memory_get("sessions/<agentId>/<file>")` is DB-first when sessions search is
  enabled, with file fallback only on `index_miss`.

## Data Model

Durable layer:

- `memory_items`: active durable knowledge.
- `memory_audit_log`: durable memory change history.

Daily layer:

- `memory_daily_entries`: DB-owned daily/current context.
- `memory_daily_extraction_windows`: processed maintenance windows for daily
  extraction.

Sessions layer:

- `session_index_files`: indexed session transcript files.
- `session_index_chunks`: searchable transcript chunks.

Import and migration:

- `memory_import_runs`: import run metadata.
- `memory_import_files`: per-file import ledger and dedupe state.

Schema management:

- `schema_migrations`: applied migration history.

Legacy cleanup:

- `memory_episodic` was removed from the active runtime path and is dropped by
  cleanup migration.

## Durable Memory

Durable memory is stored in `memory_items`.

The MVP supports `fact` and `note` items. Writes use canonical upsert behavior
through `(type, namespace, canonical_key)` so the system can update known facts
instead of appending unlimited near-duplicates.

Soft delete keeps an audit trail and avoids destructive removal as the normal
runtime path.

Use durable memory for:

- stable user preferences;
- recurring facts and habits;
- project rules and decisions;
- long-lived notes that should survive future sessions.

## Daily Memory

Daily memory is stored in `memory_daily_entries`.

This layer is for current-day context, transient notes, session captures, and
working information that should not immediately become durable memory.

Current daily inputs:

- `memory_log` writes directly into DB daily entries.
- Pre-compaction flush writes into a controlled inbox, then drains into DB.
- `/new` and `/reset` session capture writes DB-backed daily entries.
- Legacy daily files can be imported into DB daily entries.

Daily prompt injection is handled through AnchorClaw's `before_prompt_build`
path and runs on first-turn/new-session flows, not on every prompt.

## Compatibility Layer

AnchorClaw registers the OpenClaw memory capability and provides a
`MemorySearchManager` adapter so status, doctor, CLI, and prompt flows can keep
using OpenClaw's expected interfaces.

Supported parameter styles:

- AnchorClaw-native: `{ lookup, fromLine, lineCount }`
- OpenClaw aliases: `{ path, from, lines }`

File-like compatibility:

- `MEMORY.md` is a virtual DB snapshot.
- `memory/YYYY-MM-DD.md` is a DB-backed daily view.
- Direct file edits are not the normal runtime path.

After legacy migration, the physical `MEMORY.md` becomes an HTML-comment-only
stub by default so OpenClaw bootstrap does not duplicate memory in prompts.

## Sessions Corpus

Sessions search is opt-in. When `sessions.search.enabled=true`, AnchorClaw uses
Postgres-backed lexical indexing for transcript search.

Implemented behavior:

- `session_index_files` and `session_index_chunks` store index state.
- Live/delta indexing uses transcript update events plus debounce and targeted
  sync.
- `sessions.sync.deltaBytes` and `sessions.sync.deltaMessages` control reindex
  thresholds.
- Runtime lifecycle compatibility uses the preferred lifecycle registration
  when available and a legacy fallback otherwise.

Visibility modes:

- `current`: index only the current agent/session scope; cross-agent delta
  updates are ignored.
- `visible`: accept visible cross-agent transcript updates.
- `off`: disable sessions indexing/listener behavior.

State/session path resolution follows OpenClaw-compatible order:

- `OPENCLAW_STATE_DIR`
- `OPENCLAW_HOME/.openclaw`
- `HOME/.openclaw` when `OPENCLAW_HOME` is unset
- legacy `HOME/.clawdbot` when present

## Legacy Import

Legacy import is explicit operator CLI, not startup side effect.

Dry-run:

```bash
openclaw anchorclaw import
```

Apply:

```bash
openclaw anchorclaw import --apply
```

Import behavior:

- `MEMORY.md` imports into durable `memory_items`.
- `MEMORY.md` is backed up and replaced with a stub.
- `memory/YYYY-MM-DD.md` files import into `memory_daily_entries`.
- Imported daily files are archived outside the active `memory/` directory.
- Import state is tracked in the DB ledger.

Runtime/search warning behavior is scoped to actual risk: for example, zero
search hits plus active legacy import state.

## Why Legacy Daily Files Are Not an Extractor Source

AnchorClaw intentionally does not treat imported legacy
`memory/YYYY-MM-DD.md` files as a normal maintenance/extractor promotion lane.

The architectural reason is simple:

- in the normal OpenClaw flow, durable information should already have been
  distilled into `MEMORY.md`
- AnchorClaw imports `MEMORY.md` directly into durable `memory_items`
- legacy daily files are therefore archive/provenance material, not the primary
  durable migration source

Imported legacy daily rows (`source_kind='legacy_import'`) are kept for
compatibility behaviors:

- read/search of historical daily notes
- archive/backfill visibility
- import verification and operator inspection

They are not used for default durable promotion, because that would re-mine old
operational text, recreate near-duplicates that should already exist via
`MEMORY.md`, and promote smoke/debug/import/process artifacts into durable
memory.

So the intended migration model is:

1. `MEMORY.md` -> durable `memory_items`
2. legacy daily files -> DB-backed daily archive/read/search surface
3. only fresh runtime daily writes (`memory_log`) may feed maintenance/extractor
   promotion

## Maintenance and Extractor

Maintenance is optional and currently experimental.

When enabled, the scheduler reads bounded windows from `memory_daily_entries`,
runs extractor logic, deduplicates candidates, and promotes durable candidates
into `memory_items`.

Current policy:

- extractor reads only `memory_log` daily entries;
- imported `legacy_import` daily rows are excluded from promotion and remain
  archive/search/read compatibility data;
- standalone `session_memory` captures and `compaction_flush` entries are
  excluded from extractor source selection;
- backend extractor transport uses host-owned `api.runtime.llm.complete`;
- accepted candidates must pass the high-confidence durable gate before write;
- processed state is stored in `memory_daily_extraction_windows` only after a
  successful extractor cycle;
- non-dry-run maintenance waits for durable startup state to become `ready`;
- dry-run reports heuristic candidate counts only and does not run the
  extractor.

The release-safe reliability claim is still the DB-backed durable/daily runtime.
Automatic daily-to-durable promotion is a foundation path that needs ongoing
live smoke validation and tuning.

## Identity and Scope Resolution

All reads and writes run in `(user_id, workspace_id)` scope.

`workspace_id` is derived from `workspaceDir`:

- name format: `dir:<sha256(resolved workspaceDir)>`
- changing workspace directory creates a new memory scope

`user_id` resolution:

- preferred: `identity.externalId` from plugin config
- fallback: `sha256(normalized OS username)`

Operational implications:

- set `identity.externalId` for Docker and production;
- fallback identity can cause shared memory when multiple people use the same OS
  account;
- AnchorClaw logs a startup warning when fallback identity is active;
- the live agent workspace should match `plugins.entries.anchorclaw.config.workspaceDir`.

## SQL-First Search

AnchorClaw's MVP uses PostgreSQL full-text search for durable memory, daily
memory, and sessions indexing.

This gives a deterministic baseline:

- no embedding provider required;
- no vector database required;
- predictable lexical matches;
- stable fallback path for future hybrid retrieval.

## Semantic Enrichment Layer

Future semantic recall should sit above the SQL source of truth.

Planned shape:

- embeddings/vector table attached to durable and daily records;
- hybrid retrieval that combines FTS and vector scores;
- failure mode that falls back to lexical search without breaking tool APIs;
- semantic near-duplicate assistance can be added here for extractor and direct
  writes, but it should remain optional and never replace deterministic baseline
  writes;
- no semantic layer is allowed to become the only place where durable memory is
  represented.

This keeps the product position clear: AnchorClaw uses semantics for enrichment,
not as the reliability foundation.

## PostClaw-Style Future Layers

AnchorClaw can grow toward richer PostClaw-style capabilities without breaking
the core runtime contract:

- persona/profile context in separate tables and injection budgets;
- episode extraction from daily memory;
- knowledge graph relationships and multi-hop expansion;
- DB-native wiki memory or integration with OpenClaw supplements.

## Current Delivery State

Implemented and runtime-oriented:

- durable memory in Postgres;
- DB-owned daily memory;
- virtual `MEMORY.md`;
- DB-first daily memory paths;
- explicit legacy import CLI;
- sessions search as opt-in lexical corpus;
- setup path that does not patch workspace `AGENTS.md`;
- DB-backed `/new` and `/reset` session capture;
- controlled pre-compaction flush inbox and DB drain;
- maintenance foundation over DB daily windows.

Experimental:

- extractor-driven promotion from daily memory into durable memory;
- tuning of maintenance windows and live promotion smoke validation;
- semantic/vector recall layer.

Known MVP limits:

- sessions corpus is lexical-only;
- `corpus="wiki"` is not implemented by AnchorClaw itself;
- item types beyond `fact` and `note` are deferred until explicit injection and
  write policy are defined.
