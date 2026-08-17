# Changelog

## 0.1.4

### Fixed

- Restored durable-memory projection to the system prompt on every turn instead
  of prepending it to the current user prompt. This preserves the original
  memory-capability semantics while retaining multi-agent workspace routing.
- Escaped fenced-code delimiters inside untrusted daily-memory excerpts so
  stored content cannot break out of its quoted startup-context block.
- Prevented daily-memory source text from spoofing the maintenance extractor's
  trusted boundary markers.
- Honored OpenClaw startup-context controls for enablement, daily-memory days,
  per-entry characters, and total characters while preserving the same
  defaults on older supported hosts.

### Compatibility

- Replaced the removed `memory-core-host-engine-qmd` SDK dependency with a
  frozen local adapter used only on legacy OpenClaw hosts. The adapter retains
  the legacy transcript projection, metadata/runtime-context filtering,
  cron/dreaming classification, redaction, line mapping, and hashing behavior.
- Delegated session transcript search to native `sessions_search` and
  `sessions_history` on OpenClaw `>=2026.8.1-beta.1`; AnchorClaw no longer
  crawls or indexes active transcripts on those hosts.

## 0.1.3

### Packaging

- Refined the marketplace package summary to describe AnchorClaw as
  production-grade PostgreSQL memory for OpenClaw agents.

## 0.1.2

### Packaging

- Added complete ClawHub install metadata and a human-readable plugin manifest
  name.
- Made ClawHub the preferred metadata-driven install source, with npm retained
  as an explicit fallback.
- Removed the deprecated root SDK type import from the extractor without
  changing its runtime behavior.

## 0.1.1

### Packaging

- Added the required OpenClaw build metadata for ClawHub external code-plugin
  publishing.
- Aligned the lockfile package version and OpenClaw peer minimum with the
  published package contract.

## 0.1.0

### Highlights

- Added optional pgvector-backed semantic retrieval for durable memory, using
  the active OpenClaw embedding provider configuration.
- Added hybrid lexical and semantic ranking with deterministic tie-breaking that
  preserves durable-memory importance.
- Added demand-first embedding indexing and a persistent maintenance queue for
  unfinished semantic work.
- Added safe setup and upgrade support for existing SQL/FTS-only installations.

### Compatibility

- Requires OpenClaw `>=2026.5.28`.
- Semantic retrieval is opt-in. SQL/FTS remains the source-of-truth path and
  remains available when semantic dependencies are unavailable.
- Removed the inactive legacy `memory_recall` tool surface.
