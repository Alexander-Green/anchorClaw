ALTER TABLE memory_item_embeddings
  ADD COLUMN IF NOT EXISTS memory_item_version INTEGER,
  ADD COLUMN IF NOT EXISTS dimensions INTEGER;

CREATE TABLE IF NOT EXISTS semantic_indexing_requests (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_key TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'search_missing',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error TEXT,
  PRIMARY KEY (user_id, workspace_id, profile_key),
  CHECK (status IN ('pending', 'failed', 'superseded'))
);

CREATE INDEX IF NOT EXISTS semantic_indexing_requests_pending_idx
  ON semantic_indexing_requests (status, next_attempt_at, requested_at);

CREATE OR REPLACE FUNCTION semantic_indexing_requests_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS semantic_indexing_requests_updated_at ON semantic_indexing_requests;
CREATE TRIGGER semantic_indexing_requests_updated_at
BEFORE UPDATE ON semantic_indexing_requests
FOR EACH ROW
EXECUTE FUNCTION semantic_indexing_requests_set_updated_at();
