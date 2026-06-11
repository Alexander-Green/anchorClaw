CREATE TABLE IF NOT EXISTS memory_daily_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daily_entry_id UUID NOT NULL REFERENCES memory_daily_entries(id) ON DELETE CASCADE,

  block_index BIGINT NOT NULL,
  logical_date DATE NOT NULL,
  daily_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_path TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT memory_daily_blocks_block_index_check CHECK (block_index >= 0),
  UNIQUE (daily_entry_id, block_index)
);

CREATE OR REPLACE FUNCTION memory_daily_blocks_reject_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'memory_daily_blocks rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS memory_daily_blocks_reject_update_trigger
  ON memory_daily_blocks;

CREATE TRIGGER memory_daily_blocks_reject_update_trigger
BEFORE UPDATE ON memory_daily_blocks
FOR EACH ROW
EXECUTE FUNCTION memory_daily_blocks_reject_update();

CREATE INDEX IF NOT EXISTS memory_daily_blocks_scope_source_idx
  ON memory_daily_blocks (
    user_id,
    workspace_id,
    source_kind,
    logical_date,
    daily_path,
    block_index
  );

INSERT INTO memory_daily_blocks (
  user_id,
  workspace_id,
  daily_entry_id,
  block_index,
  logical_date,
  daily_path,
  content,
  content_sha256,
  source_kind,
  source_path,
  metadata,
  created_by,
  created_at
)
SELECT
  entry.user_id,
  entry.workspace_id,
  entry.id,
  0,
  entry.logical_date,
  entry.path,
  entry.content,
  entry.content_sha256,
  entry.source_kind,
  entry.source_path,
  coalesce(entry.metadata, '{}'::jsonb) || jsonb_build_object(
    'migrationSnapshot',
    true,
    'snapshotContentSha256',
    entry.content_sha256
  ),
  entry.created_by,
  entry.created_at
FROM memory_daily_entries entry
ON CONFLICT (daily_entry_id, block_index) DO NOTHING;

CREATE TABLE IF NOT EXISTS memory_daily_block_extraction_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  daily_block_id UUID NOT NULL REFERENCES memory_daily_blocks(id) ON DELETE CASCADE,
  maintenance_run_id UUID REFERENCES memory_maintenance_runs(id) ON DELETE SET NULL,

  daily_path TEXT NOT NULL,
  logical_date DATE NOT NULL,
  pipeline_version INTEGER NOT NULL,
  window_index INTEGER NOT NULL,
  window_sha256 TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT memory_daily_block_extraction_windows_pipeline_check
    CHECK (pipeline_version > 0),
  CONSTRAINT memory_daily_block_extraction_windows_index_check
    CHECK (window_index >= 0),
  CONSTRAINT memory_daily_block_extraction_windows_range_check
    CHECK (char_start >= 0 AND char_end > char_start)
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_daily_block_extraction_windows_scope_idx
  ON memory_daily_block_extraction_windows (
    user_id,
    workspace_id,
    daily_block_id,
    pipeline_version,
    window_index
  );

CREATE INDEX IF NOT EXISTS memory_daily_block_extraction_windows_lookup_idx
  ON memory_daily_block_extraction_windows (
    user_id,
    workspace_id,
    logical_date DESC,
    created_at DESC
  );

CREATE OR REPLACE FUNCTION anchorclaw_migration_0010_normalize_daily_content(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT btrim(
    replace(value, E'\r\n', E'\n'),
    E'\t\n\f\r '
      || chr(11)
      || chr(160)
      || chr(5760)
      || chr(8192)
      || chr(8193)
      || chr(8194)
      || chr(8195)
      || chr(8196)
      || chr(8197)
      || chr(8198)
      || chr(8199)
      || chr(8200)
      || chr(8201)
      || chr(8202)
      || chr(8232)
      || chr(8233)
      || chr(8239)
      || chr(8287)
      || chr(12288)
      || chr(65279)
  );
$$;

CREATE OR REPLACE FUNCTION anchorclaw_migration_0010_utf16_length(value TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  position INTEGER;
  character TEXT;
  units INTEGER := 0;
BEGIN
  FOR position IN 1..char_length(value) LOOP
    character := substr(value, position, 1);
    units := units + CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END;
  END LOOP;
  RETURN units;
END;
$$;

CREATE OR REPLACE FUNCTION anchorclaw_migration_0010_utf16_slice(
  value TEXT,
  start_offset INTEGER,
  end_offset INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  position INTEGER;
  character TEXT;
  cursor_offset INTEGER := 0;
  next_offset INTEGER;
  result TEXT := '';
BEGIN
  IF start_offset < 0 OR end_offset < start_offset THEN
    RETURN NULL;
  END IF;

  FOR position IN 1..char_length(value) LOOP
    character := substr(value, position, 1);
    next_offset :=
      cursor_offset + CASE WHEN ascii(character) > 65535 THEN 2 ELSE 1 END;

    IF (start_offset > cursor_offset AND start_offset < next_offset)
      OR (end_offset > cursor_offset AND end_offset < next_offset) THEN
      RETURN NULL;
    END IF;

    IF cursor_offset >= start_offset AND next_offset <= end_offset THEN
      result := result || character;
    END IF;

    cursor_offset := next_offset;
  END LOOP;

  IF end_offset > cursor_offset THEN
    RETURN NULL;
  END IF;

  RETURN result;
END;
$$;

WITH snapshot_blocks AS (
  SELECT
    block.id AS daily_block_id,
    block.user_id,
    block.workspace_id,
    block.daily_entry_id,
    block.daily_path,
    block.logical_date,
    block.content_sha256,
    anchorclaw_migration_0010_normalize_daily_content(block.content) AS normalized_content
  FROM memory_daily_blocks block
  WHERE block.source_kind = 'memory_log'
    AND block.metadata->>'migrationSnapshot' = 'true'
),
fixed_windows AS (
  SELECT
    block.daily_block_id,
    block.user_id,
    block.workspace_id,
    block.daily_entry_id,
    block.daily_path,
    block.logical_date,
    generated.chunk_start AS char_start,
    least(
      generated.chunk_start + 768,
      anchorclaw_migration_0010_utf16_length(block.normalized_content)
    ) AS char_end,
    generated.chunk_start / 640 AS window_index,
    anchorclaw_migration_0010_utf16_slice(
      block.normalized_content,
      generated.chunk_start,
      least(
        generated.chunk_start + 768,
        anchorclaw_migration_0010_utf16_length(block.normalized_content)
      )
    ) AS window_content
  FROM snapshot_blocks block
  CROSS JOIN LATERAL generate_series(
    0,
    anchorclaw_migration_0010_utf16_length(block.normalized_content) - 1,
    640
  ) AS generated(chunk_start)
  WHERE anchorclaw_migration_0010_utf16_length(block.normalized_content) > 0
),
verified_legacy_receipts AS (
  SELECT
    receipt.id,
    receipt.user_id,
    receipt.workspace_id,
    receipt.daily_entry_id,
    receipt.maintenance_run_id,
    receipt.char_start,
    receipt.char_end,
    receipt.created_at
  FROM memory_daily_extraction_windows receipt
  JOIN snapshot_blocks block
    ON block.user_id = receipt.user_id
   AND block.workspace_id = receipt.workspace_id
   AND block.daily_entry_id = receipt.daily_entry_id
   AND block.content_sha256 = receipt.content_sha256
  WHERE receipt.char_start >= 0
    AND receipt.char_end > receipt.char_start
    AND receipt.char_end <= anchorclaw_migration_0010_utf16_length(block.normalized_content)
    AND encode(
      digest(
        anchorclaw_migration_0010_utf16_slice(
          block.normalized_content,
          receipt.char_start,
          receipt.char_end
        ),
        'sha256'
      ),
      'hex'
    ) = receipt.window_sha256
),
covered_windows AS (
  SELECT DISTINCT ON (
    window.user_id,
    window.workspace_id,
    window.daily_block_id,
    window.window_index
  )
    window.*,
    receipt.maintenance_run_id,
    receipt.created_at,
    receipt.id AS legacy_receipt_id
  FROM fixed_windows window
  JOIN verified_legacy_receipts receipt
    ON receipt.user_id = window.user_id
   AND receipt.workspace_id = window.workspace_id
   AND receipt.daily_entry_id = window.daily_entry_id
   AND receipt.char_start <= window.char_start
   AND receipt.char_end >= window.char_end
  WHERE window.window_content IS NOT NULL
  ORDER BY
    window.user_id,
    window.workspace_id,
    window.daily_block_id,
    window.window_index,
    receipt.created_at DESC,
    receipt.id DESC
)
INSERT INTO memory_daily_block_extraction_windows (
  user_id,
  workspace_id,
  daily_block_id,
  maintenance_run_id,
  daily_path,
  logical_date,
  pipeline_version,
  window_index,
  window_sha256,
  char_start,
  char_end,
  created_at
)
SELECT
  window.user_id,
  window.workspace_id,
  window.daily_block_id,
  window.maintenance_run_id,
  window.daily_path,
  window.logical_date,
  1,
  window.window_index,
  encode(digest(window.window_content, 'sha256'), 'hex'),
  window.char_start,
  window.char_end,
  window.created_at
FROM covered_windows window
ON CONFLICT (
  user_id,
  workspace_id,
  daily_block_id,
  pipeline_version,
  window_index
) DO NOTHING;

DROP TABLE memory_daily_extraction_windows;

DROP FUNCTION anchorclaw_migration_0010_utf16_slice(TEXT, INTEGER, INTEGER);
DROP FUNCTION anchorclaw_migration_0010_utf16_length(TEXT);
DROP FUNCTION anchorclaw_migration_0010_normalize_daily_content(TEXT);
