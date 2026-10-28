import { describe, expect, it } from "vitest";
import { createTestDb } from "../harness/db";
import { loadArticles } from "@/lib/ingest/ingest";
import { translationFixtures } from "../fixtures/translation";

describe("translation enqueue", () => {
  it("enqueues translation for foreign languages and skips English", async () => {
    const db = await createTestDb();
    if (!db) return;

    try {
      process.env.ROLE = "seed";
      const { resetConfigCache } = await import("@/lib/config");
      resetConfigCache();

      // Use pool as ingest via admin (test DB has no role passwords)
      const items = [
        {
          external_id: "t-ar-1",
          source: "test",
          published_at: "2024-01-01T00:00:00Z",
          language: translationFixtures.ar.language,
          headline: translationFixtures.ar.headline,
          body: translationFixtures.ar.body,
        },
        {
          external_id: "t-en-1",
          source: "test",
          published_at: "2024-01-01T00:00:00Z",
          language: translationFixtures.en.language,
          headline: translationFixtures.en.headline,
          body: translationFixtures.en.body,
        },
        {
          external_id: "t-unk-1",
          source: "test",
          published_at: "2024-01-01T00:00:00Z",
          language: "N/A",
          headline: translationFixtures.unknown.headline,
          body: translationFixtures.unknown.body,
        },
      ];

      // loadArticles uses createPool with ROLE — set DB to test db via env
      process.env.DB_HOST = process.env.TEST_DB_HOST ?? "127.0.0.1";
      process.env.DB_PORT = process.env.TEST_DB_PORT ?? "5432";
      process.env.DB_NAME = db.dbName;
      process.env.DB_USER = process.env.TEST_DB_USER ?? "mss_admin";
      process.env.DB_PASSWORD =
        process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? "";
      resetConfigCache();

      const result = await loadArticles(items, "backfill");
      expect(result.admitted).toBe(3);

      const jobs = await db.pool.query<{
        external_id: string;
        part: string;
        state: string;
      }>(
        `SELECT a.external_id, j.part, j.state
           FROM enrichment_jobs j
           JOIN articles a ON a.id = j.article_id
          WHERE j.part = 'translation'
          ORDER BY a.external_id`,
      );
      const byExt = Object.fromEntries(jobs.rows.map((r) => [r.external_id, r]));
      expect(byExt["t-ar-1"]?.state).toBe("queued");
      expect(byExt["t-unk-1"]?.state).toBe("queued");
      expect(byExt["t-en-1"]).toBeUndefined();

      // Old overload absent
      const overloads = await db.pool.query(
        `SELECT pg_get_function_identity_arguments(oid) AS args
           FROM pg_proc WHERE proname = 'ingest_new_version'`,
      );
      expect(overloads.rows).toHaveLength(1);
      expect(overloads.rows[0].args).toMatch(/p_needs_translation|boolean, boolean/);
    } finally {
      await db.end();
    }
  }, 60_000);
});
