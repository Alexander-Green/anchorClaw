-- Language-aware full-text search.
--
-- Until now every row was indexed with the `simple` configuration, which
-- neither stems nor removes stopwords. That is language neutral but costs
-- recall: `graduate` does not match `graduated`, and under the AND semantics of
-- plainto_tsquery a natural question keeps every function word as a required
-- term, so a short fact can be unreachable.
--
-- The configuration is chosen by the application at write time (it needs script
-- and language detection, which SQL cannot do) and stored per row. The vector
-- itself is maintained by a trigger so it stays in sync when title, content or
-- canonical_key change, mirroring how search_text is handled in 0007.
--
-- Note that search_vector from 0001 is a GENERATED column pinned to `simple`
-- and cannot be reused: a generated expression must be immutable, and casting
-- text to regconfig is not.

ALTER TABLE memory_items
ADD COLUMN IF NOT EXISTS search_config TEXT NOT NULL DEFAULT 'simple';

ALTER TABLE memory_items
ADD COLUMN IF NOT EXISTS search_tsv TSVECTOR;

CREATE OR REPLACE FUNCTION memory_items_sync_search_tsv()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  resolved regconfig;
BEGIN
  -- An unknown configuration name must not break writes; fall back to `simple`,
  -- which is exactly the pre-migration behaviour.
  BEGIN
    resolved := coalesce(NEW.search_config, 'simple')::regconfig;
  EXCEPTION
    WHEN undefined_object THEN
      resolved := 'simple'::regconfig;
      NEW.search_config := 'simple';
  END;

  NEW.search_tsv := to_tsvector(resolved, coalesce(NEW.search_text, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_items_search_tsv_sync ON memory_items;

-- Fires after memory_items_search_text_sync (0007) by name ordering, so
-- NEW.search_text is already up to date when this runs.
CREATE TRIGGER memory_items_search_tsv_sync
BEFORE INSERT OR UPDATE OF title, content, canonical_key, search_text, search_config
ON memory_items
FOR EACH ROW
EXECUTE FUNCTION memory_items_sync_search_tsv();

-- Backfill.
--
-- The script table the application uses is expressible in SQL, so existing rows
-- are classified here rather than being left on 'simple' until they happen to be
-- rewritten. Verified against the application resolver: every non-Latin script
-- and every plain-Latin row is classified identically.
--
-- What SQL cannot do is tell Latin languages apart — that needs the detection
-- library. Those rows get 'english', which is the same fallback the application
-- applies to Latin text it cannot identify. Measured consequence: English rows
-- gain proper stemming, other Latin rows behave as they did under 'simple'.
--
-- Ordering matters: non-Latin scripts are tested before the Latin branch so that
-- mixed text (Cyrillic prose containing ASCII technical terms) resolves to the
-- script of its prose, whose configuration already routes ASCII tokens through
-- the English stemmer.
-- The script must be *dominant*, not merely present. Matching on presence was
-- measurably wrong on real data: an English document carrying a single Greek
-- letter from a formula, or one stray Cyrillic character, was routed to that
-- language's stemmer and ended up harder to find than under 'simple'.
UPDATE memory_items AS m
SET search_config = COALESCE(best.config, 'simple')
FROM (
  SELECT id, config
  FROM (
    SELECT
      i.id,
      c.config,
      c.hits,
      ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY c.hits DESC, c.config) AS rank
    FROM memory_items i
    CROSS JOIN LATERAL (
      VALUES
        ('russian',  regexp_count(coalesce(i.search_text, ''), '[Ѐ-ӿ]')),
        ('greek',    regexp_count(coalesce(i.search_text, ''), '[Ͱ-Ͽ]')),
        ('arabic',   regexp_count(coalesce(i.search_text, ''), '[؀-ۿ]')),
        ('hindi',    regexp_count(coalesce(i.search_text, ''), '[ऀ-ॿ]')),
        ('armenian', regexp_count(coalesce(i.search_text, ''), '[԰-֏]')),
        ('tamil',    regexp_count(coalesce(i.search_text, ''), '[஀-௿]')),
        ('yiddish',  regexp_count(coalesce(i.search_text, ''), '[֐-׿]')),
        ('english',  regexp_count(coalesce(i.search_text, ''), '[A-Za-z]'))
    ) AS c(config, hits)
    WHERE i.search_tsv IS NULL
      AND c.hits > 0
  ) ranked
  WHERE rank = 1
) AS best
WHERE m.id = best.id
  AND m.search_tsv IS NULL;

-- The trigger fills search_tsv on UPDATE, but rows whose configuration did not
-- change are not touched by the statement above.
UPDATE memory_items
SET search_tsv = to_tsvector(search_config::regconfig, coalesce(search_text, ''))
WHERE search_tsv IS NULL;

CREATE INDEX IF NOT EXISTS memory_items_search_tsv_idx
  ON memory_items USING GIN (search_tsv);
