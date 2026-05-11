-- AnchorClaw: initial schema (MVP)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE memory_item_type AS ENUM (
  'fact',
  'note',
  'profile',
  'config',
  'skill',
  'automation',
  'summary'
);

CREATE TYPE memory_item_status AS ENUM (
  'active',
  'superseded',
  'archived',
  'deleted',
  'pending_review'
);

CREATE TYPE memory_item_source AS ENUM (
  'user',
  'agent',
  'migration',
  'system',
  'integration'
);

CREATE TYPE memory_event_type AS ENUM (
  'message',
  'decision',
  'action',
  'observation',
  'correction',
  'import',
  'export'
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  display_label TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (channel, external_id)
);

CREATE INDEX user_identities_user_idx
  ON user_identities (user_id);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, name)
);

CREATE UNIQUE INDEX workspaces_one_default_per_user_idx
  ON workspaces (user_id)
  WHERE is_default = true;

CREATE TABLE memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  session_id TEXT,

  type memory_item_type NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  status memory_item_status NOT NULL DEFAULT 'active',
  source memory_item_source NOT NULL DEFAULT 'agent',

  title TEXT,
  content TEXT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'markdown',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',

  importance SMALLINT NOT NULL DEFAULT 50 CHECK (importance >= 0 AND importance <= 100),
  confidence SMALLINT NOT NULL DEFAULT 80 CHECK (confidence >= 0 AND confidence <= 100),

  valid_from TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ,

  created_by TEXT,
  updated_by TEXT,

  version INTEGER NOT NULL DEFAULT 1,
  supersedes_id UUID REFERENCES memory_items(id),
  canonical_key TEXT,

  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', content), 'B')
  ) STORED,

  CHECK (content_format IN ('markdown', 'json', 'plain'))
);

CREATE INDEX memory_items_user_status_type_idx
  ON memory_items (user_id, workspace_id, status, type, namespace);

CREATE INDEX memory_items_user_importance_recency_idx
  ON memory_items (user_id, workspace_id, status, importance DESC, updated_at DESC);

CREATE INDEX memory_items_workspace_idx
  ON memory_items (workspace_id);

CREATE INDEX memory_items_tags_idx
  ON memory_items USING GIN (tags);

CREATE INDEX memory_items_metadata_idx
  ON memory_items USING GIN (metadata);

CREATE INDEX memory_items_search_idx
  ON memory_items USING GIN (search_vector);

CREATE UNIQUE INDEX memory_items_canonical_active_idx
  ON memory_items (user_id, workspace_id, namespace, type, canonical_key)
  WHERE status = 'active' AND canonical_key IS NOT NULL;

CREATE TABLE memory_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  session_id TEXT,

  event_type memory_event_type NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  tags TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT,

  related_item_ids UUID[] NOT NULL DEFAULT '{}'
);

CREATE INDEX memory_events_user_time_idx
  ON memory_events (user_id, created_at DESC);

CREATE INDEX memory_events_workspace_time_idx
  ON memory_events (workspace_id, created_at DESC);

CREATE INDEX memory_events_tags_idx
  ON memory_events USING GIN (tags);

CREATE TABLE memory_item_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),

  from_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (from_item_id, to_item_id, relation)
);

CREATE TABLE memory_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id),
  item_id UUID REFERENCES memory_items(id) ON DELETE SET NULL,
  event_id UUID REFERENCES memory_events(id) ON DELETE SET NULL,

  operation TEXT NOT NULL,
  before JSONB,
  after JSONB,

  actor TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_audit_log_user_time_idx
  ON memory_audit_log (user_id, created_at DESC);

-- Track one-time imports from workspace files (e.g. MEMORY.md, memory/*.md) so imports are idempotent.
CREATE TABLE memory_import_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  rel_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  source_type TEXT NOT NULL, -- e.g. 'root-memory' | 'daily-memory'
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  UNIQUE (user_id, workspace_id, rel_path, sha256)
);

CREATE INDEX memory_import_files_scope_time_idx
  ON memory_import_files (user_id, workspace_id, imported_at DESC);
