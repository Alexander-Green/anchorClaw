ALTER TABLE memory_items
ADD COLUMN search_text TEXT GENERATED ALWAYS AS (
  trim(
    both ' '
    FROM concat_ws(
      ' ',
      coalesce(title, ''),
      content,
      coalesce(canonical_key, '')
    )
  )
) STORED;

CREATE INDEX memory_items_search_text_fts_idx
  ON memory_items USING GIN (to_tsvector('simple', search_text));

CREATE INDEX memory_items_search_text_trgm_idx
  ON memory_items USING GIN (lower(search_text) gin_trgm_ops);
