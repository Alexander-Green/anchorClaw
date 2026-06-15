CREATE TABLE IF NOT EXISTS memory_item_embeddings (
  memory_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  profile_key TEXT NOT NULL,
  embedding vector NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_item_id, profile_key)
);

CREATE INDEX IF NOT EXISTS memory_item_embeddings_profile_key_idx
  ON memory_item_embeddings (profile_key);

CREATE OR REPLACE FUNCTION memory_item_embeddings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS memory_item_embeddings_updated_at ON memory_item_embeddings;
CREATE TRIGGER memory_item_embeddings_updated_at
BEFORE UPDATE ON memory_item_embeddings
FOR EACH ROW
EXECUTE FUNCTION memory_item_embeddings_set_updated_at();
