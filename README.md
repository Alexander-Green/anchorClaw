<p align="center">
  <img src="./assets/logo.png" alt="AnchorClaw logo" width="800" height="600" style="display:block;margin:0 auto" />
</p>

# AnchorClaw - Reliable Postgres Memory for OpenClaw

> Alpha preview. API and operator workflows may change before stable release.
>
> Alpha migration notice:
> `plugins.entries.anchorclaw.config.workspaceDir` and
> `maintenance.extractor.agentId` were removed starting in `0.0.9`.
> The reason is the move to an explicit multi-agent workspace model, where
> runtime/import/maintenance scope is resolved from OpenClaw agent context
> instead of one global plugin workspace key.
> See [ARCHITECTURE.md#multi-agent-workspace-model](./ARCHITECTURE.md#multi-agent-workspace-model).

**No more "the agent forgot everything again."**

**This is not just another memory plugin. AnchorClaw is a full Postgres-backed
memory backend for OpenClaw's durable and daily memory runtime.**

AnchorClaw replaces fragile file-first OpenClaw memory with PostgreSQL as the
source of truth, while keeping OpenClaw's existing tools, CLI flows, and
`MEMORY.md` / `memory/YYYY-MM-DD.md` expectations compatible.

AnchorClaw is multi-agent aware. Runtime memory follows the active OpenClaw
agent workspace, while imports and background maintenance use explicit
workspace scopes. Separate workspaces remain isolated; agents that intentionally
share one workspace share one DB memory scope without duplicate processing.

It owns the real memory backend: storage, retrieval, import state, daily
context, diagnostics, and compatibility views all point back to one durable
database instead of a growing pile of Markdown files.

The core bet is simple: durable memory should be durable first.

That means SQL-first storage, deterministic writes, full-text search, clean
imports, backups, migrations, and inspectable state before adding any semantic
magic. Embeddings and semantic recall are planned as an enrichment layer on top
of the database, not as the foundation that decides whether memory survives.

**AnchorClaw is built and maintained by Alexander Green.**
Canonical repository: https://github.com/Alexander-Green/anchorClaw

## Why AnchorClaw Exists

OpenClaw's default file memory is transparent and easy to understand. It is also
easy to outgrow.

As agents run longer, memory can become noisy, duplicated, stale, or split
across files and workspaces. Session compaction and reset flows can preserve a
summary in one place while durable facts live somewhere else. Operators then
have to debug memory by reading Markdown files, prompt behavior, import state,
and tool output at the same time.

Multi-agent installations make this harder. Each agent may use its own
workspace, several agents may intentionally share one, and background jobs must
know exactly which workspaces to process. One global plugin workspace setting
cannot represent those cases safely.

Many memory systems start with embeddings or a vector database. That can help
recall, but it does not automatically solve ownership, deduplication, migration,
auditability, or deterministic updates.

AnchorClaw starts lower in the stack:

- PostgreSQL is the single source of truth.
- Markdown files become compatibility, import, export, and snapshot surfaces.
- OpenClaw tools keep working through a DB-backed compatibility layer.
- Semantic retrieval can be added later without making vectors the source of
  truth.

## What AnchorClaw Gives You

- **A full memory backend, not a wrapper around `MEMORY.md`**: storage,
  retrieval, daily context, migration state, and diagnostics are DB-backed.
- **Postgres-backed durable memory** for long-lived facts, preferences,
  decisions, project rules, and curated notes.
- **OpenClaw compatibility** for `memory_store`, `memory_log`, `memory_search`,
  `memory_get`, `memory_forget`, `memory_status`, `MEMORY.md`, and daily memory
  paths.
- **Deterministic upserts** through stable canonical keys instead of "maybe this
  duplicate is close enough."
- **Full-text search out of the box** with no embeddings required for the MVP.
- **DB-owned daily memory** with immutable append blocks for provenance and a
  canonical daily view for current context, session captures, and day-specific
  notes.
- **A safe legacy import path** that moves old `MEMORY.md` and `memory/*.md`
  content into Postgres without keeping duplicate active runtime files.
- **Multi-agent workspace routing**: runtime operations follow the active agent,
  imports target explicitly selected agents, and maintenance follows an
  explicit default, selected-agent, or all-workspaces scope.
- **Path-based workspace deduplication** so several agents pointing to the same
  physical workspace do not create duplicate maintenance or import targets.
- **Workspace and identity isolation** for cleaner multi-user and
  multi-workspace operation.
- **A future-proof base** for semantic recall, persona context, episodes, and
  knowledge graphs.

## Who It Is For

AnchorClaw is especially useful if:

- your OpenClaw agent remembers something for a while, then mysteriously loses
  it after reset, compaction, or workspace changes;
- your `MEMORY.md` and daily files keep collecting duplicates and stale notes;
- your `MEMORY.md` has become a maintenance burden: too large to search quickly,
  too noisy to trust, and too painful to clean by hand;
- you run OpenClaw in a production-like or always-on environment;
- you have multiple users, workspaces, agents, or machines;
- you want memory that can be backed up, migrated, queried, audited, and repaired
  like real application state.

## How It Works

AnchorClaw keeps the familiar OpenClaw mental model, but changes where memory
actually lives.

```text
OpenClaw tools and prompts
        |
        v
AnchorClaw compatibility layer
        |
        v
PostgreSQL source of truth
  - memory_items          durable facts and notes
  - memory_daily_entries  canonical daily/current views
  - memory_daily_blocks   immutable daily append ledger
  - session_index_*       optional sessions search
```

`MEMORY.md` becomes a virtual DB-backed snapshot. `memory/YYYY-MM-DD.md` becomes
a DB-backed daily view. Existing OpenClaw-style instructions can keep talking
about those paths, while AnchorClaw routes reads and writes through Postgres.

## Multi-Agent by Design

AnchorClaw resolves memory scope from OpenClaw's agent and workspace model
instead of relying on one global plugin workspace:

- runtime reads and writes follow the active agent's resolved workspace;
- imports explicitly target the default agent, one configured agent, or every
  unique configured agent workspace;
- background maintenance explicitly covers the default agent, selected agents,
  or all configured workspaces;
- different workspace paths map to isolated DB memory scopes;
- agents sharing the same resolved workspace path intentionally share one DB
  memory scope;
- shared paths are deduplicated before multi-workspace import and maintenance
  runs.

```text
agent main -> /work/main   -> DB workspace A
agent ops  -> /work/ops    -> DB workspace B
agent qa   -> /work/shared -> DB workspace C
agent test -> /work/shared -> DB workspace C
```

This provides multi-agent-aware memory without silently exposing one agent's
separate workspace memory to another. See
[ARCHITECTURE.md#multi-agent-workspace-model](./ARCHITECTURE.md#multi-agent-workspace-model)
for the routing contract and full workspace matrix.

## Quick Start

Prerequisites:

- OpenClaw host `>= 2026.5.12`
- Node.js
- PostgreSQL

Install the plugin:

```bash
openclaw plugins install @alexandrgreen/anchorclaw
```

Provision Postgres and write the OpenClaw config:

```bash
openclaw anchorclaw setup
```

Restart the gateway:

```bash
openclaw gateway restart
```

If you already have legacy memory files, dry-run and then apply the import:

```bash
openclaw anchorclaw import
openclaw anchorclaw import --apply
```

Setup does not need to rewrite workspace `AGENTS.md`. It configures AnchorClaw
as the OpenClaw memory slot and disables the bundled file-based `session-memory`
hook so `/new` and `/reset` captures stay DB-backed.

For manual provisioning, SSL, pool tuning, Docker-style identity, and
non-interactive setup, see [INSTALL.md](./INSTALL.md).

## What Works Today

AnchorClaw currently targets a Track A core runtime release:

- durable memory is DB-backed through `memory_items`;
- daily memory is written as immutable `memory_daily_blocks` and projected into
  DB-owned `memory_daily_entries` compatibility views;
- daily startup injection runs on first-turn/new-session paths;
- `MEMORY.md` and daily memory paths are DB-backed compatibility views;
- legacy import/backfill is an explicit operator CLI;
- sessions search is available as an explicit opt-in;
- maintenance/extractor promotion runs from stable, versioned
  `memory_log` block windows when enabled; imported legacy daily files remain
  archive/search/read compatibility data;
- extractor instructions are separated from quoted untrusted daily content to
  reduce prompt-injection risk before candidates reach the durable write gate.

The important release boundary: the durable and daily runtime path is the core
supported value. The maintenance/extractor path is a foundation for automatic
promotion from daily context into durable memory, not yet the primary reliability
claim.

## SQL First, Semantic Later

AnchorClaw is not anti-embeddings. It is anti-"embeddings are the database."

The planned semantic layer will enrich the Postgres source of truth with hybrid
retrieval: lexical search plus vector recall, with a reliable fallback when
embeddings are disabled or fail. That gives us better discovery without making
memory correctness depend on model-dependent similarity scores.

Nearer-term future work includes:

- semantic search and hybrid ranking on top of the Postgres source of truth;
- optional semantic duplicate assistance for automated promotion and direct
  writes when the semantic layer is enabled;
- persona/profile context with separate injection budgets, if a clear product
  need emerges.

## Documentation

- [INSTALL.md](./INSTALL.md) - setup, configuration, import, SSL, pool tuning,
  and manual Postgres provisioning.
- [ARCHITECTURE.md](./ARCHITECTURE.md) - data model, compatibility layer,
  corpuses, maintenance, identity, and future semantic layers.
- [TweetClaw source memory workflow](docs/integrations/tweetclaw.md) - community
  integration notes contributed by the TweetClaw/Xquik community. TweetClaw and
  Xquik are maintained separately from AnchorClaw.

## License

See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
