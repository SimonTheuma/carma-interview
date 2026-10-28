-- Article versioning, upload batch status, and open_jobs fix for superseded_version.
-- Rollback (manual, after code rollback):
--   DROP FUNCTION IF EXISTS upload_batch_status(uuid);
--   DROP FUNCTION IF EXISTS ingest_new_version(bigint, uuid, text, integer, bytea, integer, bytea, timestamptz, text, text, text, text[], text, smallint, jsonb, text, boolean);
--   -- Restore enrichment_jobs unique/check from 0001 after setting superseded_version rows to dead;
--   -- versions beyond 1 are lost from articles unless copied back from article_versions.
-- Prefer: docker compose down -v for disposable environments.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE articles SET (
  autovacuum_vacuum_scale_factor = 0.05
);

CREATE TABLE IF NOT EXISTS article_versions (
  article_id         bigint      NOT NULL REFERENCES articles(id),
  version            integer     NOT NULL,
  published_at       timestamptz NOT NULL,
  ingested_at        timestamptz NOT NULL,
  language           text        NOT NULL,
  headline           text,
  body               text,
  content_hash       bytea       NOT NULL,
  flags              text[]      NOT NULL DEFAULT '{}',
  superseded_at      timestamptz NOT NULL DEFAULT now(),
  superseded_by_event bigint     REFERENCES ingest_events(id),
  PRIMARY KEY (article_id, version)
);

ALTER TABLE ingest_events
  ADD COLUMN IF NOT EXISTS article_version integer;

ALTER TABLE enrichment_jobs
  ADD COLUMN IF NOT EXISTS article_version integer NOT NULL DEFAULT 1;

ALTER TABLE enrichments
  ADD COLUMN IF NOT EXISTS article_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'enrichment_jobs_article_id_part_prompt_version_key'
  ) THEN
    ALTER TABLE enrichment_jobs
      DROP CONSTRAINT enrichment_jobs_article_id_part_prompt_version_key;
  END IF;
EXCEPTION WHEN undefined_object THEN
  NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'enrichment_jobs_version_uq'
  ) THEN
    ALTER TABLE enrichment_jobs
      ADD CONSTRAINT enrichment_jobs_version_uq
      UNIQUE (article_id, article_version, part, prompt_version);
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE enrichment_jobs DROP CONSTRAINT IF EXISTS enrichment_jobs_state_check;
  ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_state_check CHECK (state IN
    ('queued','running','succeeded','failed_retryable','deferred_budget',
     'skipped_no_content','dead','superseded_version'));
END $$;

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
  p_has_text boolean
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
  bigint, uuid, text, integer, bytea, integer, bytea, timestamptz, text, text, text, text[], text, smallint, jsonb, text, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingest_new_version(
  bigint, uuid, text, integer, bytea, integer, bytea, timestamptz, text, text, text, text[], text, smallint, jsonb, text, boolean
) TO app_ingest;

CREATE OR REPLACE FUNCTION upload_batch_status(p_batch uuid)
RETURNS TABLE(
  item_position integer,
  outcome text,
  reason_codes text[],
  article_id bigint,
  article_version integer,
  sentiment_state text,
  summary_topics_state text,
  quarantine_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Use item_position (not "position") — POSITION is a reserved word and also
  -- clashes with RETURNS TABLE output variables under RETURN QUERY.
  RETURN QUERY
  SELECT
    e.position AS item_position,
    e.outcome,
    e.reason_codes,
    e.article_id,
    e.article_version,
    js.state AS sentiment_state,
    jt.state AS summary_topics_state,
    q.status AS quarantine_status
  FROM ingest_events e
  LEFT JOIN enrichment_jobs js
    ON js.article_id = e.article_id
   AND js.article_version = COALESCE(e.article_version, 1)
   AND js.part = 'sentiment'
  LEFT JOIN enrichment_jobs jt
    ON jt.article_id = e.article_id
   AND jt.article_version = COALESCE(e.article_version, 1)
   AND jt.part = 'summary_topics'
  LEFT JOIN ingest_quarantine q ON q.event_id = e.id
  WHERE e.batch_id = p_batch
  ORDER BY e.position
  LIMIT 5000;
END;
$$;

REVOKE ALL ON FUNCTION upload_batch_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION upload_batch_status(uuid) TO app_read;

GRANT SELECT ON article_versions TO app_read;

CREATE OR REPLACE FUNCTION status_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'articles_total', (SELECT count(*) FROM articles),
    'jobs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('part', part, 'state', state, 'n', n))
      FROM (
        SELECT part, state, count(*)::text AS n
        FROM enrichment_jobs
        GROUP BY part, state
      ) j
    ), '[]'::jsonb),
    'oldest_actionable_job_age_s', (
      SELECT extract(epoch from (now() - min(created_at)))
      FROM enrichment_jobs
      WHERE state IN ('queued','failed_retryable','deferred_budget','running')
    ),
    'budget', COALESCE((
      SELECT jsonb_agg(to_jsonb(b))
      FROM llm_budget_ledger b
      WHERE day_utc = (now() AT TIME ZONE 'UTC')::date
    ), '[]'::jsonb),
    'flags', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('key', key, 'value', value, 'updated_at', updated_at))
      FROM system_flags
    ), '[]'::jsonb),
    'quarantine_open', (
      SELECT count(*) FROM ingest_quarantine WHERE status = 'open'
    ),
    'quarantine_oldest', (
      SELECT min(e.received_at)
      FROM ingest_quarantine q
      JOIN ingest_events e ON e.id = q.event_id
      WHERE q.status = 'open'
    ),
    'watermark_published_at', (SELECT max(published_at) FROM articles),
    'watermark_ingested_at', (SELECT max(ingested_at) FROM articles),
    'dead_jobs', (
      SELECT count(*) FROM enrichment_jobs WHERE state = 'dead'
    ),
    'open_jobs', (
      SELECT count(*) FROM enrichment_jobs
      WHERE state NOT IN ('succeeded','skipped_no_content','dead','superseded_version')
    )
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION status_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION status_snapshot() TO app_read;
