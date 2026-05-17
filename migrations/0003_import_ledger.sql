ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS import_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS memory_items_import_key_active_uidx
  ON memory_items (user_id, workspace_id, import_key)
  WHERE status = 'active' AND import_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS memory_import_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  source_kind TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  parser_version INTEGER NOT NULL,

  status TEXT NOT NULL,
  parsed_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 1,

  last_error_code TEXT,
  last_error_message TEXT,
  cleanup_status TEXT NOT NULL DEFAULT 'not_needed',

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  cleanup_completed_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT memory_import_runs_status_check CHECK (
    status IN ('pending', 'running', 'completed', 'failed_retryable', 'failed_permanent')
  ),
  CONSTRAINT memory_import_runs_cleanup_status_check CHECK (
    cleanup_status IN ('not_needed', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS memory_import_runs_scope_idx
  ON memory_import_runs (user_id, workspace_id, source_kind, source_path, started_at DESC);

CREATE INDEX IF NOT EXISTS memory_import_runs_status_idx
  ON memory_import_runs (user_id, workspace_id, status, started_at DESC);
