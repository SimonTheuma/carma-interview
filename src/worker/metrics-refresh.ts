import type pg from "pg";
import { gauge, counter, histogram } from "../lib/metrics";

const jobsQueued = gauge("mss_jobs_queued", "Queued enrichment jobs by part");
const jobsByState = gauge("mss_jobs", "Enrichment jobs by part and state");
const oldestAge = gauge("mss_job_oldest_age_seconds", "Age of oldest actionable job");
const outcomes = counter("mss_job_outcomes_total", "Job terminal outcomes");
const budgetDeferred = counter("mss_budget_deferred_total", "Jobs deferred for budget");
const breakerState = gauge("mss_breaker_state", "Breaker open=1 closed=0 half=0.5");
const providerDuration = histogram(
  "mss_provider_duration_seconds",
  "Provider call duration",
  [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 15, 60],
);
const translationLag = histogram(
  "mss_translation_lag_seconds",
  "Seconds from article version time to translation created_at",
  [60, 300, 900, 1800, 3600, 7200, 21600],
);
const translationDead = counter("mss_translation_dead_total", "Translation jobs marked dead");
const foreignUntranslated = gauge(
  "mss_search_foreign_untranslated",
  "Foreign articles without a current translation",
);
const staleCurrent = gauge(
  "mss_translation_stale_current",
  "Current translations whose article_version != articles.version",
);
const indexValid = gauge("mss_search_index_valid", "Search index indisvalid (1/0)");
const indexBytes = gauge("mss_search_index_bytes", "Search index size in bytes");
const ginPending = gauge("mss_search_gin_pending_bytes", "GIN pending list estimate");
const summaryMissing = gauge(
  "mss_search_summary_missing",
  "Articles with no current summary",
);

const INDEX_MAP: Record<string, string> = {
  articles_fts_en_idx: "articles_fts_en",
  article_translations_fts_en_idx: "translations_fts_en",
  derived_values_summary_fts_en_idx: "summary_fts_en",
  derived_values_summary_fts_idx: "summary_fts",
};

export {
  outcomes,
  budgetDeferred,
  breakerState,
  providerDuration,
  translationLag,
  translationDead,
};

/** Refresh DB-derived gauges (call ~every 60s from the worker). */
export async function refreshJobGauges(pool: pg.Pool): Promise<void> {
  const counts = await pool.query<{ part: string; state: string; n: string }>(
    `SELECT part, state, count(*)::text AS n FROM enrichment_jobs GROUP BY part, state`,
  );
  const queuedByPart = new Map<string, number>();
  for (const r of counts.rows) {
    jobsByState.set({ part: r.part, state: r.state }, Number(r.n));
    if (["queued", "failed_retryable", "deferred_budget"].includes(r.state)) {
      queuedByPart.set(r.part, (queuedByPart.get(r.part) ?? 0) + Number(r.n));
    }
  }
  for (const [part, n] of queuedByPart) {
    jobsQueued.set({ part }, n);
  }

  const oldest = await pool.query<{ age: string | null; part: string; state: string }>(
    `SELECT part, state, extract(epoch from (now() - min(created_at)))::text AS age
       FROM enrichment_jobs
      WHERE state IN ('queued','failed_retryable','deferred_budget','running')
      GROUP BY part, state`,
  );
  for (const r of oldest.rows) {
    oldestAge.set({ part: r.part, state: r.state }, Number(r.age ?? 0));
  }

  const untr = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM articles a
      WHERE lower(split_part(replace(coalesce(a.language,''), '_', '-'), '-', 1))
            NOT IN ('en','eng')
        AND NOT EXISTS (
          SELECT 1 FROM article_translations t
           WHERE t.article_id = a.id AND t.article_version = a.version
             AND t.superseded_at IS NULL
        )`,
  );
  foreignUntranslated.set({}, Number(untr.rows[0]?.n ?? 0));

  const stale = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM article_translations t
       JOIN articles a ON a.id = t.article_id
      WHERE t.superseded_at IS NULL AND t.article_version <> a.version`,
  );
  staleCurrent.set({}, Number(stale.rows[0]?.n ?? 0));

  const idxs = await pool.query<{ relname: string; indisvalid: boolean; bytes: string }>(
    `SELECT c.relname, i.indisvalid, pg_relation_size(c.oid)::text AS bytes
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = ANY($1::text[])`,
    [Object.keys(INDEX_MAP)],
  );
  const seen = new Set<string>();
  for (const r of idxs.rows) {
    const label = INDEX_MAP[r.relname];
    if (!label) continue;
    seen.add(label);
    indexValid.set({ query: label }, r.indisvalid ? 1 : 0);
    indexBytes.set({ query: label }, Number(r.bytes));
    try {
      const pend = await pool.query<{ pending_pages: string }>(
        `SELECT pending_pages::text FROM pgstatginindex($1::regclass)`,
        [r.relname],
      );
      const pages = Number(pend.rows[0]?.pending_pages ?? 0);
      ginPending.set({ query: label }, pages * 8192);
    } catch {
      ginPending.set({ query: label }, 0);
    }
  }
  for (const label of Object.values(INDEX_MAP)) {
    if (!seen.has(label)) indexValid.set({ query: label }, 0);
  }

  const miss = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM articles a
      WHERE NOT EXISTS (
        SELECT 1 FROM derived_values dv
         WHERE dv.article_id = a.id AND dv.field = 'summary' AND dv.is_current
      )`,
  );
  summaryMissing.set({}, Number(miss.rows[0]?.n ?? 0));

  await refreshCoverageFlags(pool);
}

type Queryable = Pick<pg.Pool, "query">;

/** Upsert corpus-wide coverage signals for /api/search (ADR-0036). */
export async function refreshCoverageFlags(pool: Queryable): Promise<void> {
  const corpus = await pool.query<{
    total: string;
    with_sent: string;
    with_topic: string;
    max_pub: string | null;
    max_ing: string | null;
  }>(
    `SELECT
       (SELECT count(*)::text FROM articles) AS total,
       (SELECT count(DISTINCT article_id)::text FROM derived_values WHERE field='sentiment' AND is_current) AS with_sent,
       (SELECT count(DISTINCT article_id)::text FROM derived_values WHERE field='topic' AND is_current) AS with_topic,
       (SELECT max(published_at)::text FROM articles) AS max_pub,
       (SELECT max(ingested_at)::text FROM articles) AS max_ing`,
  );
  const c = corpus.rows[0];
  const coverageFlags: Array<[string, string]> = [
    ["coverage_corpus_articles", c?.total ?? "0"],
    ["coverage_enriched_sentiment", c?.with_sent ?? "0"],
    ["coverage_enriched_topics", c?.with_topic ?? "0"],
    ["coverage_watermark_published_at", c?.max_pub ?? ""],
    ["coverage_watermark_ingested_at", c?.max_ing ?? ""],
  ];
  for (const [key, value] of coverageFlags) {
    await pool.query(
      `INSERT INTO system_flags (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
}
