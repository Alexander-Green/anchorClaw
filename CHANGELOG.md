# Changelog

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
