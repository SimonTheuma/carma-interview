import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../harness/db";

const migrationPath = join(process.cwd(), "db/migrations/0004_article_translations.sql");

describe("migration 0004 article_translations", () => {
  it("static: no CREATE INDEX CONCURRENTLY (not allowed in txn migrations)", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql.toLowerCase()).not.toMatch(/create\s+index\s+concurrently/);
  });

  it("applies cleanly, is idempotent, and sets grants/indexes", async () => {
    const db = await createTestDb();
    if (!db) return;

    try {
      const tables = await db.pool.query(
        `SELECT to_regclass('public.article_translations') AS at,
                to_regclass('public.translation_chunk_cache') AS cache`,
      );
      expect(tables.rows[0].at).toBeTruthy();
      expect(tables.rows[0].cache).toBeTruthy();

      const idx = await db.pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'article_translations'
         ORDER BY indexname`,
      );
      const names = idx.rows.map((r: { indexname: string }) => r.indexname);
      expect(names).toContain("article_translations_current_uq");
      expect(names).toContain("article_translations_fts_idx");

      const parts = await db.pool.query(
        `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
         WHERE conrelid = 'enrichment_jobs'::regclass AND conname = 'enrichment_jobs_part_check'`,
      );
      expect(parts.rows[0]?.def).toMatch(/translation/);

      const flag = await db.pool.query(
        `SELECT value FROM system_flags WHERE key = 'translation_enabled'`,
      );
      expect(flag.rows[0]?.value).toBe("true");

      // Idempotent re-apply
      const { migrate, defaultMigrationsDir } = await import("@/lib/db/migrate");
      const client = await db.pool.connect();
      try {
        const result = await migrate(client, defaultMigrationsDir());
        expect(result.applied).toEqual([]);
      } finally {
        client.release();
      }

      // app_read can SELECT; cannot INSERT
      const readPw =
        process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? process.env.POSTGRES_PASSWORD ?? "";
      const readClient = new (await import("pg")).default.Client({
        host: process.env.TEST_DB_HOST ?? "127.0.0.1",
        port: Number(process.env.TEST_DB_PORT ?? 5432),
        user: "app_read",
        password: readPw,
        database: db.dbName,
      });
      // Roles may not have passwords set in test DBs created by mss_admin alone;
      // grant check via has_table_privilege as admin instead.
      const priv = await db.pool.query(
        `SELECT
           has_table_privilege('app_read', 'article_translations', 'SELECT') AS read_sel,
           has_table_privilege('app_read', 'article_translations', 'INSERT') AS read_ins,
           has_table_privilege('app_worker', 'article_translations', 'INSERT') AS worker_ins,
           has_table_privilege('app_worker', 'translation_chunk_cache', 'DELETE') AS worker_cache,
           has_table_privilege('app_read', 'translation_chunk_cache', 'SELECT') AS read_cache`,
      );
      expect(priv.rows[0].read_sel).toBe(true);
      expect(priv.rows[0].read_ins).toBe(false);
      expect(priv.rows[0].worker_ins).toBe(true);
      expect(priv.rows[0].worker_cache).toBe(true);
      expect(priv.rows[0].read_cache).toBe(false);
      void readClient;
    } finally {
      await db.end();
    }
  }, 60_000);
});
