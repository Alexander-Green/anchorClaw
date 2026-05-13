-- AnchorClaw: sessions index (phase 1 lexical)

CREATE TABLE session_index_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Stored for filtering/debug; identity key is path+scope.
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  abs_path TEXT NOT NULL,

  hash TEXT NOT NULL,
  mtime_ms DOUBLE PRECISION NOT NULL,
  size_bytes BIGINT NOT NULL,

  line_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (user_id, workspace_id, path)
);

CREATE INDEX session_index_files_scope_idx
  ON session_index_files (user_id, workspace_id, updated_at DESC);

CREATE INDEX session_index_files_agent_idx
  ON session_index_files (user_id, workspace_id, agent_id, updated_at DESC);

CREATE INDEX session_index_files_path_idx
  ON session_index_files (user_id, workspace_id, path);

CREATE TABLE session_index_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES session_index_files(id) ON DELETE CASCADE,

  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,

  chunk_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,

  message_timestamps_ms BIGINT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(path, '')), 'A') ||
    setweight(to_tsvector('simple', text), 'B')
  ) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (file_id, chunk_index)
);

CREATE INDEX session_index_chunks_scope_idx
  ON session_index_chunks (user_id, workspace_id, path);

CREATE INDEX session_index_chunks_agent_idx
  ON session_index_chunks (user_id, workspace_id, agent_id, path);

CREATE INDEX session_index_chunks_search_idx
  ON session_index_chunks USING GIN (search_vector);
