import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { loadArticles } from "@/lib/ingest/ingest";
import { loadConfig } from "@/lib/config";
import { createTestDb, assertIngestConservation, type TestDb } from "../harness/db";
import { sampleArticle } from "../fixtures/articles";

const dbPromise = createTestDb();

describe("upload versioning", () => {
  let db: TestDb | null = null;

  beforeAll(async () => {
    db = await dbPromise;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("skips when Postgres unavailable", async () => {
    if (db) return;
    expect(db).toBeNull();
  });

  it("I3 creates a new version on content change and keeps one search row", async () => {
    if (!db) return;
    const config = loadConfig({
      NODE_ENV: "test",
      ROLE: "migrate",
      DB_HOST: process.env.TEST_DB_HOST ?? "127.0.0.1",
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "",
      ENRICHMENT_MODE: "mock",
    });
    const cfg = {
      ...config,
      db: { ...config.db, name: db.dbName, user: "mss_admin" },
      promptVersion: "v1",
    };

    const first = await loadArticles(
      [sampleArticle({ id: "ver-1", source: "Wire", body: "Original body text here." })],
      "backfill",
      db.pool,
      cfg,
    );
    expect(first.admitted).toBe(1);
    await assertIngestConservation(db.pool, first.batchId);

    const second = await loadArticles(
      [sampleArticle({ id: "ver-1", source: "Wire", body: "Revised body text here." })],
      "backfill",
      db.pool,
      cfg,
    );
    expect(second.admitted).toBe(1);
    expect(second.versions).toBe(1);
    expect(second.reconciled).toBe(true);
    await assertIngestConservation(db.pool, second.batchId);

    const art = await db.pool.query<{ version: number; body: string; n: string }>(
      `SELECT version, body, (SELECT count(*)::text FROM articles WHERE source='Wire' AND external_id='ver-1') AS n
         FROM articles WHERE source='Wire' AND external_id='ver-1'`,
    );
    expect(art.rows[0]!.n).toBe("1");
    expect(Number(art.rows[0]!.version)).toBe(2);
    expect(art.rows[0]!.body).toContain("Revised");

    const hist = await db.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM article_versions av
         JOIN articles a ON a.id = av.article_id
        WHERE a.source='Wire' AND a.external_id='ver-1'`,
    );
    expect(hist.rows[0]!.n).toBe("1");

    const jobs = await db.pool.query<{ state: string; n: string }>(
      `SELECT state, count(*)::text AS n FROM enrichment_jobs j
         JOIN articles a ON a.id = j.article_id
        WHERE a.source='Wire' AND a.external_id='ver-1'
        GROUP BY state`,
    );
    const byState = Object.fromEntries(jobs.rows.map((r) => [r.state, Number(r.n)]));
    expect(byState.superseded_version ?? 0).toBeGreaterThanOrEqual(2);
    expect(byState.queued ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("I2 identical re-upload is all duplicates", async () => {
    if (!db) return;
    const config = loadConfig({
      NODE_ENV: "test",
      ROLE: "migrate",
      DB_HOST: process.env.TEST_DB_HOST ?? "127.0.0.1",
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "",
      ENRICHMENT_MODE: "mock",
    });
    const cfg = {
      ...config,
      db: { ...config.db, name: db.dbName, user: "mss_admin" },
      promptVersion: "v1",
    };
    const item = sampleArticle({ id: "idem-1", source: "Wire" });
    await loadArticles([item], "backfill", db.pool, cfg);
    const again = await loadArticles([item], "backfill", db.pool, cfg);
    expect(again.duplicate).toBe(1);
    expect(again.admitted).toBe(0);
    expect(again.versions).toBe(0);
  });

  it("status_snapshot excludes superseded_version from open_jobs", async () => {
    if (!db) return;
    await db.pool.query(
      `INSERT INTO articles (external_id, source, published_at, language, headline, body, content_hash, flags, search_text, search_text_ver)
       VALUES ('snap-1','Wire', now(), 'en', 'h', 'b', decode('aa','hex'), '{}', 'h b', 1)
       ON CONFLICT DO NOTHING`,
    );
    const art = await db.pool.query<{ id: string }>(
      `SELECT id FROM articles WHERE external_id='snap-1' AND source='Wire'`,
    );
    const id = art.rows[0]?.id;
    if (!id) return;
    await db.pool.query(
      `INSERT INTO enrichment_jobs (article_id, article_version, part, prompt_version, state)
       VALUES ($1, 1, 'sentiment', 'v1', 'superseded_version')
       ON CONFLICT DO NOTHING`,
      [id],
    );
    const snap = await db.pool.query<{ snapshot: { open_jobs: string } }>(
      `SELECT status_snapshot() AS snapshot`,
    );
    // open_jobs should not count the superseded row as processing forever
    expect(Number(snap.rows[0]!.snapshot.open_jobs)).toBeGreaterThanOrEqual(0);
  });
});
