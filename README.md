<p align="center">
  <img src="./assets/logo.png" alt="AnchorClaw logo" width="640" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@alexandrgreen/anchorclaw"><img alt="npm version" src="https://img.shields.io/npm/v/@alexandrgreen/anchorclaw" /></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/@alexandrgreen/anchorclaw" /></a>
  <img alt="OpenClaw 2026.5.28 or newer" src="https://img.shields.io/badge/OpenClaw-%3E%3D2026.5.28-1f6f5c" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-backed-336791" />
</p>

# AnchorClaw - Reliable Postgres Memory for OpenClaw

**No more "the agent forgot everything again."**

AnchorClaw turns OpenClaw memory into real application state: PostgreSQL-backed,
inspectable, migratable, and aware of agent workspace boundaries.

Durable facts, daily context, session continuity, import state, and search live
behind one reliable database layer. OpenClaw keeps its familiar memory tools and
file-shaped paths. Full-text search works without embeddings, while optional
semantic retrieval improves recall without becoming the source of truth.

[Quick Start](#quick-start) · [Installation Guide](./INSTALL.md) ·
[Architecture](./ARCHITECTURE.md)

## From Memory Files to Memory Infrastructure

File memory is transparent and useful. It is also easy to outgrow once an agent
runs for weeks, survives resets, or shares a host with other agents.

| Before AnchorClaw | With AnchorClaw |
| --- | --- |
| Durable knowledge drifts across Markdown files and sessions. | Durable and daily memory are DB-backed and auditable. |
| `/new`, `/reset`, and compaction can scatter useful context. | Session capture and controlled compaction flushes feed one daily memory layer. |
| `MEMORY.md` grows noisy, stale, and difficult to repair. | `MEMORY.md` becomes a virtual snapshot generated from PostgreSQL. |
| Search depends on files or an embedding provider. | PostgreSQL FTS is always available; semantic recall is optional. |
| One global plugin workspace becomes ambiguous with several agents. | Memory scope follows OpenClaw agent/workspace routing. |
| Imports and background jobs can process the same workspace twice. | Explicit targets and resolved-path deduplication make ownership predictable. |

AnchorClaw is built around one principle: **durable memory should be durable
first**. Storage, deterministic writes, migrations, provenance, and lexical
search come before semantic similarity.

## What You Get

- **Memory that survives**: durable facts, preferences, rules, and notes remain
  available across sessions, gateway restarts, `/new`, `/reset`, and
  compaction.
- **SQL-first retrieval**: PostgreSQL full-text search works out of the box,
  with stable ordering and no embedding provider required.
- **Safe daily context**: daily writes use immutable append blocks for
  provenance and a canonical DB view for prompts, search, and file-shaped
  compatibility.
- **OpenClaw memory compatibility**: `memory_store`, `memory_log`,
  `memory_search`, `memory_get`, `memory_forget`, `memory_status`, virtual
  `MEMORY.md`, and DB-backed daily paths remain available through the normal
  OpenClaw memory capability.
- **Multi-agent workspace boundaries**: separate workspace paths map to
  isolated DB scopes; agents that intentionally share a workspace share one
  memory scope.
- **No duplicate workspace processing**: import and maintenance targets are
  deduplicated by resolved workspace path, not merely by agent name.
- **Safe legacy migration**: inspect before applying, select the destination
  explicitly, archive imported files, and fail closed when a migration is
  incomplete.
- **Controlled daily-to-durable promotion**: optional maintenance can extract
  high-confidence durable candidates from bounded, versioned `memory_log`
  windows.
- **Operational visibility**: health, migration state, import state, semantic
  queues, and degraded behavior are visible through `memory_status`, tool
  details, PostgreSQL, and logs.
- **Optional sessions search**: transcript indexing is DB-first, opt-in, and
  constrained by agent/workspace visibility.

## How It Works

```text
OpenClaw tools, prompts, reset and compaction lifecycle
                         |
                         v
              AnchorClaw memory capability
                         |
             +-----------+-----------+
             |                       |
             v                       v
       PostgreSQL FTS          Optional pgvector
             |                semantic enrichment
             +-----------+-----------+
                         |
                         v
              PostgreSQL source of truth
                - durable memory
                - daily memory
                - session index
                - import/maintenance state
```

`MEMORY.md` is a virtual DB-backed snapshot. `memory/YYYY-MM-DD.md` is a
DB-backed daily view. Existing OpenClaw-style instructions can keep referring to
those paths while AnchorClaw owns the actual reads and writes.

Daily memory is append-safe: immutable blocks preserve where each write came
from, while a canonical projection gives prompts and tools one current document
per day. `/new` and `/reset` captures use the same DB-backed layer. Before
compaction, important context can pass through a controlled flush inbox and be
recovered into PostgreSQL.

For the table model, lifecycle hooks, search corpuses, and failure boundaries,
see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Multi-Agent by Design

AnchorClaw does not keep one global plugin workspace. Runtime scope follows the
active OpenClaw agent's resolved workspace.

```text
agent main -> /work/main   -> DB workspace A
agent ops  -> /work/ops    -> DB workspace B
agent qa   -> /work/shared -> DB workspace C
agent test -> /work/shared -> DB workspace C
```

- `main` and `ops` remain isolated because their workspace paths differ.
- `qa` and `test` intentionally share memory because they resolve to the same
  path.
- Shared paths are processed once during all-workspace import and maintenance.
- Imports target the default agent, one configured agent, or all unique agent
  workspaces explicitly.
- Background maintenance uses an explicit workspace scope instead of guessing.

User identity and workspace identity are separate boundaries. For Docker,
multiple machines, or long-lived deployments, configure a stable
`identity.externalId`; workspace isolation continues to follow resolved
OpenClaw workspace paths.

See the full routing contract and workspace matrix in
[ARCHITECTURE.md#multi-agent-workspace-model](./ARCHITECTURE.md#multi-agent-workspace-model).

## SQL First, Semantic When You Want It

AnchorClaw is not anti-embeddings. It is anti-"embeddings are the database."

Without semantic retrieval, the complete durable and daily runtime remains
available through PostgreSQL and FTS. With semantic enabled, AnchorClaw adds
pgvector-backed recall for durable `memory_items` and combines lexical and
vector ranks during `memory_search`.

- Durable writes commit before best-effort embedding work.
- Missing or stale embeddings are indexed on demand in bounded batches.
- Remaining work is represented by lightweight maintenance requests.
- Provider, key, schema, or vector failures degrade back to lexical search.
- Daily memory and sessions remain lexical in the current release.
- `memory_status(check=true)` can actively verify the configured embedding
  provider without writing a memory item.

The semantic layer is a derived index. PostgreSQL `memory_items` remains the
durable source of truth.

## Built for Operational Failure

AnchorClaw makes failure modes explicit instead of hiding them behind prompts:

- an unavailable embedding provider leaves SQL/FTS retrieval working;
- an incomplete import reports failure instead of claiming clean migration;
- active legacy files are detected and reported;
- startup drains recoverable compaction flushes into the DB;
- maintenance processes bounded windows and records completed work;
- one workspace failure is isolated from other selected maintenance targets;
- semantic indexing requests survive restart and are retried by maintenance;
- extractor policy is separated from quoted daily text, which is treated as
  untrusted input before durable promotion.

Normal PostgreSQL backups, migrations, queries, and audit review remain
available because memory is stored as application data rather than opaque
prompt state.

## Quick Start

Requirements:

- OpenClaw `>= 2026.5.28`
- Node.js
- PostgreSQL

Install AnchorClaw:

```bash
openclaw plugins install @alexandrgreen/anchorclaw
```

Verify that the plugin is active as the OpenClaw memory slot owner:

```bash
openclaw plugins inspect anchorclaw
```

If it is installed but not active, enable it:

```bash
openclaw plugins enable anchorclaw
```

Provision PostgreSQL and update the OpenClaw config:

```bash
openclaw anchorclaw setup
```

Restart the gateway:

```bash
openclaw gateway restart
```

If legacy `MEMORY.md` or `memory/YYYY-MM-DD.md` files exist, inspect the import
plan and then apply it:

```bash
openclaw anchorclaw import
openclaw anchorclaw import --apply
```

Setup can optionally configure a semantic provider and provision PostgreSQL
`vector`. Initial semantic provisioning requires a PostgreSQL admin connection;
the restarted gateway applies AnchorClaw's semantic table migrations through
the configured app user.

For non-interactive setup, Docker identity, semantic providers, SSL, pool
tuning, import selectors, manual provisioning, and SQL-only-to-semantic
upgrades, use the [Installation and Configuration Guide](./INSTALL.md).

## Documentation

- [Installation and Configuration](./INSTALL.md) - setup, semantic opt-in,
  legacy import, identity, SSL, pool tuning, and manual PostgreSQL provisioning.
- [Architecture](./ARCHITECTURE.md) - data model, runtime contracts, lifecycle,
  multi-agent routing, maintenance/extractor, and semantic enrichment.
- [TweetClaw source memory workflow](docs/integrations/tweetclaw.md) - community
  integration notes for TweetClaw/Xquik users. Those projects are maintained
  separately from AnchorClaw.

## Maintainer and License

AnchorClaw is created and maintained by
[Alexander Green](https://github.com/Alexander-Green).

Licensed under the [MIT License](./LICENSE). See [NOTICE](./NOTICE) for
additional attribution.

If AnchorClaw makes your agents more reliable, consider starring the
[repository](https://github.com/Alexander-Green/anchorClaw).
