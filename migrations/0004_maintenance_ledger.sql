CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run BOOLEAN NOT NULL DEFAULT true,

  scanned_count INTEGER NOT NULL DEFAULT 0,
  heuristic_candidate_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT memory_maintenance_runs_status_check CHECK (
    status IN ('running', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS memory_maintenance_runs_scope_idx
  ON memory_maintenance_runs (user_id, workspace_id, source_kind, started_at DESC);
