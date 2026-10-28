-- Article translations: schema, chunk cache, widened part CHECKs, ingest_new_version.
-- Rollback (manual, after code rollback):
--   UPDATE system_flags SET value='false' WHERE key='translation_enabled';
--   DROP FUNCTION IF EXISTS ingest_new_version(
--     bigint, uuid, text, integer, bytea, integer, bytea, timestamptz,
--     text, text, text, text[], text, smallint, jsonb, text, boolean, boolean);
--   -- Restore ingest_new_version from 0003 (17-arg signature) and re-grant EXECUTE
--   DROP TABLE IF EXISTS translation_chunk_cache;
--   DROP TABLE IF EXISTS article_translations;
--   DELETE FROM enrichments WHERE part = 'translation';
--   DELETE FROM enrichment_jobs WHERE part = 'translation';
--   -- Restore part CHECKs to ('sentiment','summary_topics') via NOT VALID / VALIDATE
-- Prefer: docker compose down -v for disposable environments.

-- Widen enrichment_jobs.part CHECK (lookup name; NOT VALID then VALIDATE)
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'enrichment_jobs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%sentiment%summary_topics%'
    AND pg_get_constraintdef(oid) NOT LIKE '%translation%'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE enrichment_jobs DROP CONSTRAINT %I', cname);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'enrichment_jobs'::regclass
      AND conname = 'enrichment_jobs_part_check'
  ) THEN
    ALTER TABLE enrichment_jobs
      ADD CONSTRAINT enrichment_jobs_part_check
      CHECK (part IN ('sentiment','summary_topics','translation')) NOT VALID;
  END IF;
  ALTER TABLE enrichment_jobs VALIDATE CONSTRAINT enrichment_jobs_part_check;
END $$;

DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'enrichments'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%sentiment%summary_topics%'
    AND pg_get_constraintdef(oid) NOT LIKE '%translation%'
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE enrichments DROP CONSTRAINT %I', cname);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'enrichments'::regclass
      AND conname = 'enrichments_part_check'
  ) THEN
    ALTER TABLE enrichments
      ADD CONSTRAINT enrichments_part_check
      CHECK (part IN ('sentiment','summary_topics','translation')) NOT VALID;
  END IF;
  ALTER TABLE enrichments VALIDATE CONSTRAINT enrichments_part_check;
END $$;

CREATE TABLE IF NOT EXISTS article_translations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id       bigint      NOT NULL REFERENCES articles(id),
  article_version  integer     NOT NULL,
  target_lang      text        NOT NULL DEFAULT 'en',
  source_lang      text,
  detected_lang    text,
  headline_en      text,
  body_en          text,
  search_text      text        NOT NULL,
  search_text_ver  smallint    NOT NULL,
  search_vector    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  enrichment_id    bigint      NOT NULL REFERENCES enrichments(id),
  chunk_count      smallint    NOT NULL,
  flags            text[]      NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz,
  CONSTRAINT at_has_text CHECK (headline_en IS NOT NULL OR body_en IS NOT NULL)
) WITH (fillfactor = 90);

ALTER TABLE article_translations SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.05
);

CREATE UNIQUE INDEX IF NOT EXISTS article_translations_current_uq
  ON article_translations (article_id, target_lang) WHERE superseded_at IS NULL;

CREATE INDEX IF NOT EXISTS article_translations_fts_idx
  ON article_translations USING GIN (search_vector) WHERE superseded_at IS NULL;

DO $$
BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS article_translations_trgm_idx
      ON article_translations USING GIN (search_text gin_trgm_ops)
      WHERE superseded_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL; -- trgm may be off; ILIKE still works
  END;
END $$;

CREATE TABLE IF NOT EXISTS translation_chunk_cache (
  job_id      bigint      NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
  chunk_idx   smallint    NOT NULL,
  input_hash  bytea       NOT NULL,
  output      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, chunk_idx)
);

ALTER TABLE translation_chunk_cache SET (
  autovacuum_vacuum_scale_factor = 0.02
);

GRANT SELECT ON article_translations TO app_read;
GRANT SELECT, INSERT ON article_translations TO app_worker;
GRANT UPDATE (superseded_at) ON article_translations TO app_worker;
GRANT SELECT, INSERT, DELETE ON translation_chunk_cache TO app_worker;

INSERT INTO system_flags (key, value) VALUES ('translation_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;

-- Replace ingest_new_version: add p_needs_translation; supersede translations; enqueue translation job.
DROP FUNCTION IF EXISTS ingest_new_version(
  bigint, uuid, text, integer, bytea, integer, bytea, timestamptz,
  text, text, text, text[], text, smallint, jsonb, text, boolean
);

CREATE OR REPLACE FUNCTION ingest_new_version(
  p_article_id bigint,
  p_batch_id uuid,
  p_batch_kind text,
  p_position integer,
  p_payload_sha256 bytea,
  p_byte_size integer,
  p_new_hash bytea,
  p_published_at timestamptz,
  p_language text,
  p_headline text,
  p_body text,
  p_flags text[],
  p_search_text text,
  p_search_text_ver smallint,
  p_transformations jsonb,
  p_prompt_version text,
  p_has_text boolean,
  p_needs_translation boolean
)
RETURNS TABLE(result text, new_version integer, event_id bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cur RECORD;
  v_new integer;
  v_event_id bigint;
  t jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('article'), p_article_id::integer);

  SELECT a.id, a.version, a.published_at, a.ingested_at, a.language,
         a.headline, a.body, a.content_hash, a.flags
    INTO cur
    FROM articles a
   WHERE a.id = p_article_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'article % not found', p_article_id;
  END IF;

  IF cur.content_hash = p_new_hash THEN
    result := 'unchanged';
    new_version := cur.version;
    event_id := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO article_versions (
    article_id, version, published_at, ingested_at, language,
    headline, body, content_hash, flags, superseded_at
  ) VALUES (
    p_article_id, cur.version, cur.published_at, cur.ingested_at, cur.language,
    cur.headline, cur.body, cur.content_hash, cur.flags, now()
  );

  v_new := cur.version + 1;

  UPDATE articles SET
    published_at = p_published_at,
    language = p_language,
    headline = p_headline,
    body = p_body,
    content_hash = p_new_hash,
    flags = p_flags,
    search_text = p_search_text,
    search_text_ver = p_search_text_ver,
    version = v_new,
    updated_at = now()
  WHERE id = p_article_id;

  UPDATE enrichments
     SET superseded_at = now()
   WHERE article_id = p_article_id AND superseded_at IS NULL;

  UPDATE article_translations
     SET superseded_at = now()
   WHERE article_id = p_article_id AND superseded_at IS NULL;

  UPDATE derived_values
     SET is_current = false
   WHERE article_id = p_article_id AND is_current;

  UPDATE enrichment_jobs
     SET state = 'superseded_version',
         reason_code = 'new_version',
         claim_expires_at = NULL,
         updated_at = now()
   WHERE article_id = p_article_id
     AND article_version < v_new
     AND state IN ('queued','failed_retryable','deferred_budget','running');

  IF p_transformations IS NOT NULL THEN
    FOR t IN SELECT * FROM jsonb_array_elements(p_transformations)
    LOOP
      INSERT INTO ingest_transformations (article_id, field, kind, detail, tool, tool_version)
      VALUES (
        p_article_id,
        t->>'field',
        t->>'kind',
        t->'detail',
        t->>'tool',
        t->>'tool_version'
      );
    END LOOP;
  END IF;

  INSERT INTO enrichment_jobs (article_id, article_version, part, prompt_version, state, reason_code)
  VALUES
    (p_article_id, v_new, 'sentiment', p_prompt_version,
     CASE WHEN p_has_text THEN 'queued' ELSE 'skipped_no_content' END,
     CASE WHEN p_has_text THEN NULL ELSE 'no_content' END),
    (p_article_id, v_new, 'summary_topics', p_prompt_version,
     CASE WHEN p_has_text THEN 'queued' ELSE 'skipped_no_content' END,
     CASE WHEN p_has_text THEN NULL ELSE 'no_content' END);

  IF p_needs_translation THEN
    INSERT INTO enrichment_jobs (article_id, article_version, part, prompt_version, state, reason_code)
    VALUES (
      p_article_id, v_new, 'translation', p_prompt_version,
      CASE WHEN p_has_text THEN 'queued' ELSE 'skipped_no_content' END,
      CASE WHEN p_has_text THEN NULL ELSE 'no_content' END
    );
  END IF;

  INSERT INTO ingest_events (
    batch_id, batch_kind, position, payload_sha256, byte_size,
    outcome, reason_codes, article_id, article_version
  ) VALUES (
    p_batch_id, p_batch_kind, p_position, p_payload_sha256, p_byte_size,
    'admitted', p_flags || ARRAY['new_version']::text[], p_article_id, v_new
  )
  RETURNING id INTO v_event_id;

  UPDATE article_versions
     SET superseded_by_event = v_event_id
   WHERE article_id = p_article_id AND version = cur.version;

  result := 'admitted';
  new_version := v_new;
  event_id := v_event_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION ingest_new_version(
  bigint, uuid, text, integer, bytea, integer, bytea, timestamptz,
  text, text, text, text[], text, smallint, jsonb, text, boolean, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_new_version(
  bigint, uuid, text, integer, bytea, integer, bytea, timestamptz,
  text, text, text, text[], text, smallint, jsonb, text, boolean, boolean
) TO app_ingest;
