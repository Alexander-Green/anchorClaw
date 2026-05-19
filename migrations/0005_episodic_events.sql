CREATE TABLE IF NOT EXISTS memory_episodic (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT,
  session_key TEXT,
  session_id TEXT,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_archived BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS memory_episodic_scope_time_idx
  ON memory_episodic (user_id, workspace_id, is_archived, created_at ASC);

CREATE INDEX IF NOT EXISTS memory_episodic_event_type_idx
  ON memory_episodic (event_type, created_at DESC);
