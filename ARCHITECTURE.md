# AnchorClaw — Architecture (vs OpenClaw memory-core / PostClaw)

## TL;DR

AnchorClaw makes **Postgres the source of truth** for durable memory while preserving **compatibility with OpenClaw memory interfaces** (tools + `MemorySearchManager`) so that `status/doctor/CLI` keep working transparently.

The MVP is intentionally **SQL-first and deterministic** (no embeddings). Semantics/persona/knowledge-graph features are separate, optional layers that can be added later without breaking core paths.

## Why Not Just PostClaw

PostClaw is a DB+embeddings-first architecture with more AI-native features (semantics, persona, knowledge graph).

AnchorClaw solves a different problem:

- preserve OpenClaw UX and compatibility (contracts, corpuses, CLI/doctor/status)
- make durable memory **structured and updateable** (canonical upsert, stable ordering, audit trail)
- provide baseline reliability and predictability **without requiring embeddings**

## Data Sources (MVP)

- `corpus="memory"`: Postgres (`memory_items`) durable memory (MVP: `fact` + `note`)
- `corpus="sessions"`: Postgres-backed lexical sessions index (`session_index_files` + `session_index_chunks`), DB-first reads/search with file fallback only on `index_miss`
- `corpus="all"`: deterministic merge (`memory + sessions`)
- `corpus="wiki"`: stub for now; wiki layer is future work

Current delivery state:

- Sessions Phase 1 and Phase 2 are implemented, green in repo tests/typecheck, and runtime-verified on VPS (`server-166`).
- Live/delta freshness loop is active: `onSessionTranscriptUpdate` listener + debounce + targeted sync.
- Delta sync thresholds are config-driven via `sessions.sync.deltaBytes` / `sessions.sync.deltaMessages` (defaults: `100000` / `50`, aligned with OpenClaw defaults).
- `sessions.visibility` behavior is runtime-verified:
  - `current`: cross-agent delta updates are ignored
  - `visible`: cross-agent delta updates are accepted and indexed
  - `off`: sessions delta listener is disabled
- Runtime lifecycle compatibility fallback is enabled:
  - preferred: `api.lifecycle.registerRuntimeLifecycle`
  - fallback: `api.registerRuntimeLifecycle` (legacy hosts)
- State/session path resolution follows OpenClaw-compatible order:
  - `OPENCLAW_STATE_DIR`
  - `OPENCLAW_HOME/.openclaw` (or `HOME/.openclaw` when `OPENCLAW_HOME` is unset)
  - legacy `HOME/.clawdbot` when present

## `memory_status` Semantics

`memory_status` is operator-focused diagnostics with two modes:

- default (`check` omitted / `false`): cached runtime degraded-state (`sdkHealth`)
- active (`check: true`): lightweight runtime checks for:
  - DB connectivity (`SELECT 1`)
  - required schema objects (`memory_items`, `session_index_files`, `session_index_chunks`, `schema_migrations`)
  - latest applied migration id
  - current-agent sessions directory status (`exists`) and explicit read-access check (`readable`)
  - in-memory pending sessions delta counters

This keeps default calls cheap, while allowing explicit active checks when health validation is needed.

## Virtual `MEMORY.md`

OpenClaw core historically expects `MEMORY.md` to be readable.

In AnchorClaw:

- `memory_get(path="MEMORY.md")` and `MemorySearchManager.readFile({relPath:"MEMORY.md"})` return a **Postgres snapshot** (virtual view)
- after migration, the physical `MEMORY.md` becomes an HTML-comment-only stub by default so that:
  - OpenClaw bootstrap does not duplicate memory in prompts
  - users can see where backups are and that Postgres is the source of truth

## Why Legacy Daily Files Are Not an Extractor Source

AnchorClaw intentionally does **not** treat imported legacy `memory/YYYY-MM-DD.md`
files as a normal maintenance/extractor input lane.

The architectural reason is simple:

- in the normal OpenClaw flow, durable information should already have been
  distilled into `MEMORY.md`
- AnchorClaw imports `MEMORY.md` directly into durable `memory_items`
- legacy daily files are therefore archive/provenance material, not the primary
  durable migration source

Because of that, imported legacy daily rows (`source_kind='legacy_import'`) are
kept for compatibility behaviors:

- read/search of historical daily notes
- archive/backfill visibility
- import verification and operator inspection

But they are **not** used for default durable promotion, because that would:

- re-mine noisy operational text that was already upstream of `MEMORY.md`
- duplicate or near-duplicate facts that were already imported through the
  normal durable path
- promote smoke/debug/import/process artifacts from old daily logs into durable
  memory

So the intended migration model is:

1. `MEMORY.md` -> durable `memory_items`
2. legacy daily files -> DB-backed daily archive/read/search surface
3. only fresh runtime daily writes (`memory_log`) may feed maintenance/extractor
   promotion

This is a deliberate design choice, not a temporary omission.

## Data Model (Simplified)

Durable layer:

- `memory_items`: active durable knowledge
  - canonical upsert via `(type, namespace, canonical_key)` (MVP namespace=default)
  - `status='active'|'deleted'` (soft delete)
- `memory_audit_log`: change history (before/after); future: retention/redaction policy

History/episodes (foundation for PostClaw parity):

- `memory_events`: append-only events (MVP: import `memory/*.md` as snapshot events)

## Identity and Scope Resolution (MVP)

All reads/writes run in scope `(user_id, workspace_id)`.

- `workspace_id`:
  - derived from `workspaceDir` (`name = dir:<sha256(resolved workspaceDir)>`)
  - changing workspace directory creates a new memory scope
- `user_id`:
  - priority: `identity.externalId` from plugin config (stable key, `channel=anchorclaw-config`)
  - fallback: `sha256(normalized OS username)` (`channel=openclaw-cli`)

Operational implications:

- For Docker/production, `identity.externalId` should always be set; otherwise scope may drift when container OS user changes.
- The plugin always logs a startup warning if `identity.externalId` is not configured.

## Where PostClaw-Style Features Fit

### Semantic layer (optional)

- separate embeddings (vector) table + hybrid retrieval
- reliability contract: if embeddings are disabled or fail, fall back to lexical (FTS) without degrading tool APIs
- semantic near-duplicate assistance belongs to this optional layer, not to the
  baseline extractor/write path; see `ANCHORCLAW_SEMANTIC_LAYER_PLAN.md`

### Persona context (optional)

- separate types/tables for persona/profile
- separate injection budgets (do not mix with durable facts)

### Knowledge graph (optional)

- `entity_edges`-style relationships
- multi-hop expansion of related nodes during retrieval

## Known MVP Limits

- sessions corpus remains lexical-only (FTS). Semantic/vector layer is still future work.
- `corpus="wiki"`: not implemented
- types beyond `fact/note` are deferred until explicit injection/write policy is defined
