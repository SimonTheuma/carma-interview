import type pg from "pg";
import type { EnrichmentPart } from "../lib/translate/part";

export type ClaimedJob = {
  id: string;
  articleId: string;
  articleVersion: number;
  attempts: number;
  part: EnrichmentPart;
  reservedMicro: number;
};

export async function claimJobs(
  db: pg.PoolClient,
  part: EnrichmentPart,
  workerId: string,
  limit: number,
  visibilitySeconds = 180,
): Promise<ClaimedJob[]> {
  const res = await db.query<{
    id: string;
    article_id: string;
    article_version: number;
    attempts: number;
    part: string;
    reserved_micro: string;
  }>(
    `WITH c AS (
       SELECT id FROM enrichment_jobs
        WHERE part = $1
          AND state IN ('queued','failed_retryable','deferred_budget')
          AND next_attempt_at <= now()
        ORDER BY next_attempt_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE enrichment_jobs j
        SET state = 'running',
            claimed_by = $3,
            claimed_at = now(),
            claim_expires_at = now() + ($4::text || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = now()
       FROM c WHERE j.id = c.id
     RETURNING j.id, j.article_id, j.article_version, j.attempts, j.part, j.reserved_micro`,
    [part, limit, workerId, String(visibilitySeconds)],
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    articleId: String(r.article_id),
    articleVersion: Number(r.article_version ?? 1),
    attempts: r.attempts,
    part: r.part as EnrichmentPart,
    reservedMicro: Number(r.reserved_micro ?? 0),
  }));
}

/** Release a claim without counting as a real attempt (breaker pre-check path). */
export async function releaseUnchanged(
  db: pg.PoolClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  await db.query(
    `UPDATE enrichment_jobs
        SET state = 'queued',
            claimed_by = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            attempts = greatest(0, attempts - 1),
            updated_at = now()
      WHERE id = $1 AND claimed_by = $2 AND state = 'running'`,
    [jobId, workerId],
  );
}

/** Mark a job superseded when the article version changed under a running claim. */
export async function markSupersededVersion(
  db: pg.PoolClient,
  jobId: string,
  workerId: string,
): Promise<{ reservedMicro: number } | null> {
  const res = await db.query<{ reserved_micro: string }>(
    `WITH prev AS (
       SELECT id, reserved_micro FROM enrichment_jobs
        WHERE id = $1 AND claimed_by = $2 AND state = 'running'
       FOR UPDATE
     )
     UPDATE enrichment_jobs j
        SET state = 'superseded_version',
            reason_code = 'new_version',
            claimed_by = NULL,
            claim_expires_at = NULL,
            reserved_micro = 0,
            updated_at = now()
       FROM prev WHERE j.id = prev.id
     RETURNING prev.reserved_micro`,
    [jobId, workerId],
  );
  if (!res.rows[0]) return null;
  return { reservedMicro: Number(res.rows[0].reserved_micro) };
}
