import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { loadArticles } from "@/lib/ingest/ingest";
import { loadConfig } from "@/lib/config";
import { createTestDb, assertIngestConservation, type TestDb } from "../harness/db";
import { sampleArticle } from "../fixtures/articles";

const dbPromise = createTestDb();

describe("ingest integration", () => {
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

  it("quarantines a malformed item mid-batch and continues", async () => {
    if (!db) return;
    const config = loadConfig({
      NODE_ENV: "test",
      ROLE: "migrate",
      DB_HOST: process.env.TEST_DB_HOST ?? "127.0.0.1",
      DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "",
      ENRICHMENT_MODE: "mock",
    });

    const result = await loadArticles(
      [
        sampleArticle({ id: "good-1" }),
        { not: "an article" },
        sampleArticle({ id: "good-2", headline: "Later article still admitted" }),
      ],
      "backfill",
      db.pool,
      { ...config, db: { ...config.db, name: db.dbName, user: "mss_admin" }, promptVersion: "v1" },
    );

    expect(result.admitted).toBe(2);
    expect(result.quarantined).toBe(1);
    expect(result.duplicate).toBe(0);
    expect(result.received).toBe(3);
    await assertIngestConservation(db.pool, result.batchId);
  });

  it("records duplicate delivery of the same article id", async () => {
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
      [sampleArticle({ id: "dup-1", source: "Wire" })],
      "backfill",
      db.pool,
      cfg,
    );
    expect(first.admitted).toBe(1);

    const second = await loadArticles(
      [sampleArticle({ id: "dup-1", source: "Wire", headline: "Changed headline" })],
      "backfill",
      db.pool,
      cfg,
    );
    // Changed content becomes a new version (ADR-0021), not a silent duplicate.
    expect(second.admitted).toBe(1);
    expect(second.versions).toBe(1);
    expect(second.duplicate).toBe(0);

    const n = await db.pool.query<{ n: string; version: number }>(
      `SELECT count(*)::text AS n, max(version) AS version FROM articles WHERE source = 'Wire' AND external_id = 'dup-1'`,
    );
    expect(n.rows[0]!.n).toBe("1");
    expect(Number(n.rows[0]!.version)).toBe(2);

    const identical = await loadArticles(
      [sampleArticle({ id: "dup-1", source: "Wire", headline: "Changed headline" })],
      "backfill",
      db.pool,
      cfg,
    );
    expect(identical.duplicate).toBe(1);
    expect(identical.admitted).toBe(0);
  });
});

