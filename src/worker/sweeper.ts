import type pg from "pg";
import type { AppConfig } from "../lib/config";

export async function sweepExpired(db: pg.Pool | pg.PoolClient): Promise<number> {
  const res = await db.query(
    `WITH expired AS (
       SELECT id, reserved_micro, part FROM enrichment_jobs
        WHERE state = 'running' AND claim_expires_at < now()
       FOR UPDATE SKIP LOCKED
     )
     UPDATE enrichment_jobs j
        SET state = 'failed_retryable',
            claimed_by = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            reserved_micro = 0,
            reason_code = 'provider_timeout',
            last_error = 'claim expired',
            updated_at = now()
       FROM expired e WHERE j.id = e.id
     RETURNING j.id`,
  );
  return res.rowCount ?? 0;
}

/** Purge chunk cache for terminal jobs older than cacheDays; delete superseded translations. */
export async function sweepTranslationRetention(
  db: pg.Pool | pg.PoolClient,
  config: AppConfig["translation"],
): Promise<{ cacheDeleted: number; translationsDeleted: number }> {
  const cache = await db.query(
    `DELETE FROM translation_chunk_cache c
      USING enrichment_jobs j
      WHERE c.job_id = j.id
        AND j.state IN ('succeeded','dead','skipped_no_content','superseded_version')
        AND j.updated_at < now() - ($1::text || ' days')::interval`,
    [String(config.cacheDays)],
  );
  const tr = await db.query(
    `DELETE FROM article_translations
      WHERE superseded_at IS NOT NULL
        AND superseded_at < now() - ($1::text || ' days')::interval`,
    [String(config.supersededDays)],
  );
  return {
    cacheDeleted: cache.rowCount ?? 0,
    translationsDeleted: tr.rowCount ?? 0,
  };
}
