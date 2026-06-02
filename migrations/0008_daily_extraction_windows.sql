CREATE TABLE IF NOT EXISTS memory_daily_extraction_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daily_entry_id UUID NOT NULL REFERENCES memory_daily_entries(id) ON DELETE CASCADE,
  maintenance_run_id UUID REFERENCES memory_maintenance_runs(id) ON DELETE SET NULL,

  daily_path TEXT NOT NULL,
  logical_date DATE NOT NULL,
  content_sha256 TEXT NOT NULL,
  window_index INTEGER NOT NULL,
  window_sha256 TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_daily_extraction_windows_scope_idx
  ON memory_daily_extraction_windows (user_id, workspace_id, daily_entry_id, content_sha256, window_index);

CREATE INDEX IF NOT EXISTS memory_daily_extraction_windows_lookup_idx
  ON memory_daily_extraction_windows (user_id, workspace_id, logical_date DESC, created_at DESC);
