-- Media Signal Service initial schema
-- Rollback (manual): DROP SCHEMA public CASCADE; CREATE SCHEMA public;
-- Prefer: docker compose down -v

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_ingest') THEN
    CREATE ROLE app_ingest LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_read') THEN
    CREATE ROLE app_read LOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION set_role_password(role_name text, pwd text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, pwd);
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE TABLE IF NOT EXISTS articles (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id      text        NOT NULL,
  source           text        NOT NULL,
  published_at     timestamptz NOT NULL,
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  language         text        NOT NULL DEFAULT 'und',
  headline         text,
  body             text,
  content_hash     bytea       NOT NULL,
  flags            text[]      NOT NULL DEFAULT '{}',
  search_text      text        NOT NULL,
  search_text_ver  smallint    NOT NULL,
  search_vector    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  CONSTRAINT articles_has_text CHECK (headline IS NOT NULL OR body IS NOT NULL),
  CONSTRAINT articles_source_ext_uq UNIQUE (source, external_id)
);

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id        bigint NOT NULL REFERENCES articles(id),
  part              text   NOT NULL CHECK (part IN ('sentiment','summary_topics')),
  prompt_version    text   NOT NULL,
  state             text   NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','running','succeeded','failed_retryable',
                                     'deferred_budget','skipped_no_content','dead')),
  attempts          smallint NOT NULL DEFAULT 0,
  invalid_attempts  smallint NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  claimed_by        text,
  claimed_at        timestamptz,
  claim_expires_at  timestamptz,
  reserved_micro    bigint NOT NULL DEFAULT 0,
  reason_code       text,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, part, prompt_version)
) WITH (fillfactor = 80);

ALTER TABLE enrichment_jobs SET (
  autovacuum_vacuum_scale_factor = 0.02
);

CREATE TABLE IF NOT EXISTS enrichments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id       bigint NOT NULL REFERENCES articles(id),
  part             text   NOT NULL CHECK (part IN ('sentiment','summary_topics')),
  provider         text   NOT NULL,
  model            text   NOT NULL,
  model_reported   text,
  prompt_version   text   NOT NULL,
  origin           text   NOT NULL CHECK (origin IN ('provider','cache','mock')),
  input_hash       bytea  NOT NULL,
  input_truncated  boolean NOT NULL DEFAULT false,
  input_tokens     integer,
  output_tokens    integer,
  cost_micro       bigint,
  trust            text   NOT NULL DEFAULT 'normal' CHECK (trust IN ('normal','low')),
  raw_output       jsonb,
  job_id           bigint REFERENCES enrichment_jobs(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS enrichments_current_uq
  ON enrichments (article_id, part) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS derived_values (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrichment_id     bigint NOT NULL REFERENCES enrichments(id),
  article_id        bigint NOT NULL REFERENCES articles(id),
  field             text   NOT NULL CHECK (field IN ('sentiment','summary','topic')),
  value             text   NOT NULL,
  rank              smallint,
  vocab_version     smallint,
  confidence_norm   numeric(5,2) CHECK (confidence_norm BETWEEN 0 AND 100),
  confidence_raw    double precision,
  scale_min         double precision,
  scale_max         double precision,
  confidence_origin text   NOT NULL CHECK (confidence_origin IN
                      ('classifier_concentration','llm_self_report','none','mock','human')),
  method            text   NOT NULL,
  extra             jsonb,
  is_current        boolean NOT NULL DEFAULT true,
  CONSTRAINT dv_conf_complete CHECK (
    (confidence_norm IS NULL AND confidence_origin = 'none')
    OR (confidence_norm IS NOT NULL AND confidence_raw IS NOT NULL
        AND scale_min IS NOT NULL AND scale_max IS NOT NULL AND scale_min < scale_max))
);

CREATE TABLE IF NOT EXISTS llm_budget_ledger (
  provider       text   NOT NULL,
  day_utc        date   NOT NULL,
  currency       text   NOT NULL,
  cap_micro      bigint NOT NULL,
  reserved_micro bigint NOT NULL DEFAULT 0,
  spent_micro    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day_utc),
  CHECK (reserved_micro >= 0 AND spent_micro >= 0)
);

CREATE TABLE IF NOT EXISTS system_flags (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingest_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       uuid   NOT NULL,
  batch_kind     text   NOT NULL DEFAULT 'backfill' CHECK (batch_kind IN ('live','backfill')),
  position       integer NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  payload_sha256 bytea  NOT NULL,
  byte_size      integer NOT NULL,
  outcome        text   NOT NULL CHECK (outcome IN ('admitted','quarantined','duplicate')),
  reason_codes   text[] NOT NULL DEFAULT '{}',
  article_id     bigint REFERENCES articles(id)
);

CREATE TABLE IF NOT EXISTS ingest_quarantine (
  event_id   bigint PRIMARY KEY REFERENCES ingest_events(id),
  reason_codes text[] NOT NULL,
  field_errors jsonb,
  payload_text text,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','replayed','discarded')),
  resolved_at timestamptz,
  note text,
  replayed_article_id bigint REFERENCES articles(id)
);

CREATE TABLE IF NOT EXISTS ingest_transformations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id bigint NOT NULL REFERENCES articles(id),
  field text NOT NULL,
  kind text NOT NULL,
  detail jsonb,
  tool text NOT NULL,
  tool_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS articles_keyset_idx ON articles (published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS articles_source_keyset_idx ON articles (source, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS articles_lang_keyset_idx ON articles (language, published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS articles_fts_idx ON articles USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS articles_hash_idx ON articles (content_hash);

DO $$
BEGIN
  BEGIN
    CREATE INDEX IF NOT EXISTS articles_trgm_idx ON articles USING GIN (search_text gin_trgm_ops);
    INSERT INTO system_flags (key, value) VALUES ('trgm_index', 'on')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO system_flags (key, value) VALUES ('trgm_index', 'off')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END;
END $$;

CREATE INDEX IF NOT EXISTS jobs_claim_idx ON enrichment_jobs (part, next_attempt_at, id)
  WHERE state IN ('queued','failed_retryable','deferred_budget');
CREATE INDEX IF NOT EXISTS jobs_running_idx ON enrichment_jobs (claim_expires_at)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS jobs_article_idx ON enrichment_jobs (article_id, part);
CREATE INDEX IF NOT EXISTS dv_article_idx ON derived_values (article_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS dv_sentiment_idx ON derived_values (value, article_id)
  WHERE field = 'sentiment' AND is_current;
CREATE INDEX IF NOT EXISTS dv_topic_idx ON derived_values (value, article_id)
  WHERE field = 'topic' AND is_current;
CREATE INDEX IF NOT EXISTS events_batch_idx ON ingest_events (batch_id, position);
CREATE INDEX IF NOT EXISTS events_hash_idx ON ingest_events (payload_sha256);
CREATE INDEX IF NOT EXISTS transf_article_idx ON ingest_transformations (article_id);

CREATE OR REPLACE FUNCTION worker_set_flag(p_key text, p_value text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_key NOT LIKE 'worker.%' AND p_key NOT LIKE 'breaker.%' THEN
    RAISE EXCEPTION 'app_worker may only write worker.* or breaker.* flags';
  END IF;
  INSERT INTO system_flags (key, value, updated_at)
  VALUES (p_key, p_value, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION worker_set_flag(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_set_flag(text, text) TO app_worker;

GRANT USAGE ON SCHEMA public TO app_ingest, app_worker, app_read;

GRANT SELECT, INSERT ON articles TO app_ingest;
GRANT SELECT ON articles TO app_worker, app_read;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_ingest, app_worker;

GRANT INSERT ON ingest_events, ingest_quarantine, ingest_transformations, enrichment_jobs TO app_ingest;
GRANT SELECT ON ingest_events TO app_ingest;
GRANT SELECT ON ingest_transformations TO app_read;

GRANT SELECT ON enrichment_jobs TO app_worker, app_read;
GRANT UPDATE ON enrichment_jobs TO app_worker;

GRANT SELECT, INSERT ON enrichments TO app_worker;
GRANT UPDATE (superseded_at) ON enrichments TO app_worker;
GRANT SELECT ON enrichments TO app_read;

GRANT SELECT, INSERT ON derived_values TO app_worker;
GRANT UPDATE (is_current) ON derived_values TO app_worker;
GRANT SELECT ON derived_values TO app_read;

GRANT SELECT, INSERT, UPDATE ON llm_budget_ledger TO app_worker;
GRANT SELECT ON llm_budget_ledger TO app_read;

GRANT SELECT ON system_flags TO app_worker, app_read, app_ingest;

ALTER ROLE app_read SET statement_timeout = '2s';

INSERT INTO system_flags (key, value) VALUES ('enrichment_enabled', 'true')
  ON CONFLICT (key) DO NOTHING;
