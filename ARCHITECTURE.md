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
- `corpus="sessions"`: best-effort scan of session JSONL files on disk (compatibility layer, no index yet)
- `corpus="all"`: deterministic merge (`memory + sessions`)
- `corpus="wiki"`: stub for now; wiki layer is future work

## Virtual `MEMORY.md`

OpenClaw core historically expects `MEMORY.md` to be readable.

In AnchorClaw:

- `memory_get(path="MEMORY.md")` and `MemorySearchManager.readFile({relPath:"MEMORY.md"})` return a **Postgres snapshot** (virtual view)
- after migration, the physical `MEMORY.md` becomes an HTML-comment-only stub by default so that:
  - OpenClaw bootstrap does not duplicate memory in prompts
  - users can see where backups are and that Postgres is the source of truth

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

### Persona context (optional)

- separate types/tables for persona/profile
- separate injection budgets (do not mix with durable facts)

### Knowledge graph (optional)

- `entity_edges`-style relationships
- multi-hop expansion of related nodes during retrieval

## Known MVP Limits

- sessions corpus: best-effort scan + size cap + `score=1` (no index yet)
- `corpus="wiki"`: not implemented
- types beyond `fact/note` are deferred until explicit injection/write policy is defined
