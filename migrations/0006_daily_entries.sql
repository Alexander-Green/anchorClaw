CREATE TABLE memory_daily_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),

  logical_date DATE NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,

  source_kind TEXT NOT NULL DEFAULT 'legacy_import',
  source_path TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);

CREATE UNIQUE INDEX memory_daily_entries_user_workspace_path_idx
  ON memory_daily_entries (user_id, workspace_id, path);

CREATE INDEX memory_daily_entries_user_workspace_date_idx
  ON memory_daily_entries (user_id, workspace_id, logical_date DESC, updated_at DESC);

CREATE INDEX memory_daily_entries_search_idx
  ON memory_daily_entries USING GIN (to_tsvector('simple', content));

INSERT INTO memory_daily_entries (
  user_id,
  workspace_id,
  logical_date,
  path,
  content,
  content_sha256,
  source_kind,
  source_path,
  metadata,
  created_at,
  updated_at,
  created_by
)
SELECT DISTINCT ON (me.user_id, me.workspace_id, me.metadata->>'legacy_file')
  me.user_id,
  me.workspace_id,
  to_date(substring(me.metadata->>'legacy_file' from 'memory/([0-9]{4}-[0-9]{2}-[0-9]{2})\.md'), 'YYYY-MM-DD'),
  me.metadata->>'legacy_file',
  me.content,
  coalesce(nullif(me.metadata->>'legacy_sha256', ''), encode(digest(me.content, 'sha256'), 'hex')),
  'legacy_import',
  me.metadata->>'absolute_path',
  me.metadata,
  me.created_at,
  me.created_at,
  me.created_by
FROM memory_events me
WHERE me.event_type = 'import'
  AND me.metadata ? 'legacy_file'
  AND coalesce(me.metadata->>'legacy_file', '') ~ '^memory/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$'
ORDER BY
  me.user_id,
  me.workspace_id,
  me.metadata->>'legacy_file',
  me.created_at DESC,
  me.id DESC;
