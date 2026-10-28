-- Helpers so app_read can serve /api/readyz and /api/status without quarantine table access.
-- Rollback: DROP FUNCTION status_snapshot(); DROP VIEW IF EXISTS schema_migrations_count; REVOKE SELECT ON schema_migrations FROM app_read;

GRANT SELECT ON schema_migrations TO app_read;

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
      WHERE state NOT IN ('succeeded','skipped_no_content','dead')
    )
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION status_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION status_snapshot() TO app_read;
