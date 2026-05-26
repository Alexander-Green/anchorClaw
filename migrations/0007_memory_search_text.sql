ALTER TABLE memory_items
ADD COLUMN IF NOT EXISTS search_text TEXT;

UPDATE memory_items
SET search_text = btrim(
  coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(canonical_key, '')
)
WHERE search_text IS DISTINCT FROM btrim(
  coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(canonical_key, '')
);

CREATE OR REPLACE FUNCTION memory_items_sync_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text := btrim(
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '') || ' ' || coalesce(NEW.canonical_key, '')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_items_search_text_sync ON memory_items;

CREATE TRIGGER memory_items_search_text_sync
BEFORE INSERT OR UPDATE OF title, content, canonical_key
ON memory_items
FOR EACH ROW
EXECUTE FUNCTION memory_items_sync_search_text();

CREATE INDEX IF NOT EXISTS memory_items_search_text_fts_idx
  ON memory_items USING GIN (to_tsvector('simple', search_text));

CREATE INDEX IF NOT EXISTS memory_items_search_text_trgm_idx
  ON memory_items USING GIN (lower(search_text) gin_trgm_ops);
