-- no-transaction
-- English stemmed expression indexes (ADR-0030/0034/0035) and simple summary FTS
-- (ADR-0036 Amendment B). English indexes serve only `*` stem half; simple summary
-- index serves exact/phrase/prefix on summaries. No summary trigram.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS articles_fts_en_idx;
--           DROP INDEX CONCURRENTLY IF EXISTS article_translations_fts_en_idx;
--           DROP INDEX CONCURRENTLY IF EXISTS derived_values_summary_fts_en_idx;
--           DROP INDEX CONCURRENTLY IF EXISTS derived_values_summary_fts_idx;

-- Drop invalid leftovers from an interrupted concurrent build (re-run safe).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname AS indexname
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN (
       'articles_fts_en_idx',
       'article_translations_fts_en_idx',
       'derived_values_summary_fts_en_idx',
       'derived_values_summary_fts_idx'
     )
       AND NOT i.indisvalid
  LOOP
    EXECUTE format('DROP INDEX CONCURRENTLY IF EXISTS %I', r.indexname);
  END LOOP;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_fts_en_idx
  ON articles USING GIN (to_tsvector('english', search_text))
  WHERE split_part(language, '-', 1) IN ('en', 'und');

CREATE INDEX CONCURRENTLY IF NOT EXISTS article_translations_fts_en_idx
  ON article_translations USING GIN (to_tsvector('english', search_text))
  WHERE superseded_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS derived_values_summary_fts_en_idx
  ON derived_values USING GIN (to_tsvector('english', value))
  WHERE field = 'summary' AND is_current;

CREATE INDEX CONCURRENTLY IF NOT EXISTS derived_values_summary_fts_idx
  ON derived_values USING GIN (to_tsvector('simple', value))
  WHERE field = 'summary' AND is_current;

-- Fail loudly if any required index is missing or invalid after build.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN (
     'articles_fts_en_idx',
     'article_translations_fts_en_idx',
     'derived_values_summary_fts_en_idx',
     'derived_values_summary_fts_idx'
   )
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'invalid search index(es) after migration 0007: %', bad;
  END IF;

  IF to_regclass('public.articles_fts_en_idx') IS NULL
     OR to_regclass('public.article_translations_fts_en_idx') IS NULL
     OR to_regclass('public.derived_values_summary_fts_en_idx') IS NULL
     OR to_regclass('public.derived_values_summary_fts_idx') IS NULL THEN
    RAISE EXCEPTION 'required search index missing after migration 0007';
  END IF;
END $$;
