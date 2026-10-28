import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";
import { finishSentiment, finishFromCache, hashInput } from "@/worker/finish";
import { ensureBudgetDay, dollarsToMicro } from "@/worker/budget";

const dbPromise = createTestDb();

describe("worker finish / cache integration", () => {
  let db: TestDb | null = null;

  beforeAll(async () => {
    db = await dbPromise;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("skips cleanly when Postgres is unavailable", async () => {
    if (db) return;
    expect(db).toBeNull();
  });

  it("lost claim does not write enrichments (F1)", async () => {
    if (!db) return;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const art = await client.query<{ id: string }>(
        `INSERT INTO articles (external_id, source, published_at, language, headline, body, content_hash, flags, search_text, search_text_ver)
         VALUES ('lc-1','t',now(),'en','H','B', decode(md5('lc-1'),'hex'), '{}', 'H B', 1)
         RETURNING id`,
      );
      const articleId = art.rows[0]!.id;
      const job = await client.query<{ id: string }>(
        `INSERT INTO enrichment_jobs (article_id, part, prompt_version, state, claimed_by, attempts)
         VALUES ($1, 'sentiment', 'v1', 'running', 'worker-A', 1)
         RETURNING id`,
        [articleId],
      );
      // Simulate reclaim by another worker
      await client.query(
        `UPDATE enrichment_jobs SET claimed_by = 'worker-B' WHERE id = $1`,
        [job.rows[0]!.id],
      );
      await ensureBudgetDay(client, "jev", "2026-07-14", "USD", dollarsToMicro(5));
      await client.query(
        `UPDATE llm_budget_ledger SET reserved_micro = 10000 WHERE provider = 'jev' AND day_utc = '2026-07-14'`,
      );

      const ok = await finishSentiment(client, {
        jobId: job.rows[0]!.id,
        articleId,
        articleVersion: 1,
        workerId: "worker-A",
        promptVersion: "v1",
        inputHash: hashInput("H\n\nB", "v1"),
        truncated: false,
        trust: "normal",
        costMicro: 0,
        reservedMicro: 10000,
        providerBudgetKey: "jev",
        dayUtc: "2026-07-14",
        result: {
          value: { choice: "neutral", confidence: 0.5 },
          raw: {},
          usage: {},
          model: "mock",
          origin: "mock",
        },
      });
      expect(ok).toBe(false);
      const enr = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM enrichments WHERE article_id = $1`,
        [articleId],
      );
      expect(enr.rows[0]!.n).toBe("0");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("cache hit writes origin=cache with cost 0", async () => {
    if (!db) return;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const a1 = await client.query<{ id: string }>(
        `INSERT INTO articles (external_id, source, published_at, language, headline, body, content_hash, flags, search_text, search_text_ver)
         VALUES ('c1','t',now(),'en','Same','Body text here', decode(md5('c1'),'hex'), '{}', 'Same Body', 1)
         RETURNING id`,
      );
      const a2 = await client.query<{ id: string }>(
        `INSERT INTO articles (external_id, source, published_at, language, headline, body, content_hash, flags, search_text, search_text_ver)
         VALUES ('c2','t',now(),'en','Same','Body text here', decode(md5('c2'),'hex'), '{duplicate_content}', 'Same Body', 1)
         RETURNING id`,
      );
      const inputHash = hashInput("Same\n\nBody text here", "v1");
      const src = await client.query<{ id: string }>(
        `INSERT INTO enrichments (
           article_id, part, provider, model, prompt_version, origin, input_hash, cost_micro, trust, raw_output
         ) VALUES ($1,'sentiment','mock','mock-sentiment-v1','v1','mock',$2,0,'normal','{}'::jsonb)
         RETURNING id`,
        [a1.rows[0]!.id, inputHash],
      );
      await client.query(
        `INSERT INTO derived_values (
           enrichment_id, article_id, field, value, confidence_norm, confidence_raw,
           scale_min, scale_max, confidence_origin, method, is_current
         ) VALUES ($1,$2,'sentiment','neutral',50,0.5,0,1,'mock','mock:lexicon',true)`,
        [src.rows[0]!.id, a1.rows[0]!.id],
      );
      const job = await client.query<{ id: string }>(
        `INSERT INTO enrichment_jobs (article_id, part, prompt_version, state, claimed_by, attempts)
         VALUES ($1,'sentiment','v1','running','worker-C',1) RETURNING id`,
        [a2.rows[0]!.id],
      );
      await ensureBudgetDay(client, "jev", "2026-07-14", "USD", dollarsToMicro(5));
      await client.query(
        `UPDATE llm_budget_ledger SET reserved_micro = 10000 WHERE provider = 'jev' AND day_utc = '2026-07-14'`,
      );

      const ok = await finishFromCache(client, {
        jobId: job.rows[0]!.id,
        articleId: a2.rows[0]!.id,
        articleVersion: 1,
        workerId: "worker-C",
        promptVersion: "v1",
        inputHash,
        truncated: false,
        trust: "normal",
        reservedMicro: 10000,
        providerBudgetKey: "jev",
        dayUtc: "2026-07-14",
        part: "sentiment",
        cachedEnrichmentId: src.rows[0]!.id,
      });
      expect(ok).toBe(true);

      const enr = await client.query<{ origin: string; cost_micro: string | null }>(
        `SELECT origin, cost_micro::text FROM enrichments WHERE article_id = $1 AND superseded_at IS NULL`,
        [a2.rows[0]!.id],
      );
      expect(enr.rows[0]!.origin).toBe("cache");
      expect(Number(enr.rows[0]!.cost_micro)).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("budget exhaustion defers the job", async () => {
    if (!db) return;
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const art = await client.query<{ id: string }>(
        `INSERT INTO articles (external_id, source, published_at, language, headline, body, content_hash, flags, search_text, search_text_ver)
         VALUES ('bud-1','t',now(),'en','H','B', decode(md5('bud'),'hex'), '{}', 'H B', 1)
         RETURNING id`,
      );
      const job = await client.query<{ id: string }>(
        `INSERT INTO enrichment_jobs (article_id, part, prompt_version, state, claimed_by, attempts)
         VALUES ($1,'sentiment','v1','running','worker-D',1) RETURNING id`,
        [art.rows[0]!.id],
      );
      await ensureBudgetDay(client, "jev", "2026-07-14", "USD", 1000);
      // Cap already fully spent+reserved
      await client.query(
        `UPDATE llm_budget_ledger SET spent_micro = 1000, reserved_micro = 0
          WHERE provider = 'jev' AND day_utc = '2026-07-14'`,
      );

      const { reserveBudget } = await import("@/worker/budget");
      const remaining = await reserveBudget(client, "jev", "2026-07-14", 10000);
      expect(remaining).toBeNull();

      await client.query(
        `UPDATE enrichment_jobs
            SET state = 'deferred_budget', reason_code = 'budget_exhausted',
                next_attempt_at = (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC',
                claimed_by = NULL, claim_expires_at = NULL
          WHERE id = $1`,
        [job.rows[0]!.id],
      );
      const row = await client.query<{ state: string; reason_code: string }>(
        `SELECT state, reason_code FROM enrichment_jobs WHERE id = $1`,
        [job.rows[0]!.id],
      );
      expect(row.rows[0]!.state).toBe("deferred_budget");
      expect(row.rows[0]!.reason_code).toBe("budget_exhausted");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
