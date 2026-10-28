import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, seedArticles } from "../harness/db";

const migrationPath = join(process.cwd(), "db/migrations/0007_english_search_indexes.sql");

const REQUIRED = [
  "articles_fts_en_idx",
  "article_translations_fts_en_idx",
  "derived_values_summary_fts_en_idx",
  "derived_values_summary_fts_idx",
];

describe("migration 0007 english search indexes", () => {
  it("static: file is marked -- no-transaction and uses CONCURRENTLY", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/--\s*no-transaction/);
    expect(sql.toLowerCase()).toMatch(/create\s+index\s+concurrently/);
    expect(sql).toMatch(/derived_values_summary_fts_idx/);
    expect(sql).not.toMatch(/derived_values_summary_trgm_idx/);
  });

  it("applies cleanly, indexes valid, idempotent, handles invalid leftover", async () => {
    const db = await createTestDb();
    if (!db) return;

    try {
      for (const name of REQUIRED) {
        const reg = await db.pool.query(`SELECT to_regclass($1) AS r`, [`public.${name}`]);
        expect(reg.rows[0].r).toBeTruthy();
      }

      const valid = await db.pool.query<{ relname: string; indisvalid: boolean }>(
        `SELECT c.relname, i.indisvalid
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1::text[])`,
        [REQUIRED],
      );
      expect(valid.rows.length).toBe(4);
      for (const r of valid.rows) {
        expect(r.indisvalid).toBe(true);
      }

      // Idempotent re-apply
      const { migrate, defaultMigrationsDir } = await import("@/lib/db/migrate");
      const client = await db.pool.connect();
      try {
        const result = await migrate(client, defaultMigrationsDir());
        expect(result.applied).toEqual([]);
      } finally {
        client.release();
      }

      // Drop and re-create one index concurrently to restore
      await db.pool.query(`DROP INDEX IF EXISTS derived_values_summary_fts_idx`);
      await db.pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS derived_values_summary_fts_idx
           ON derived_values USING GIN (to_tsvector('simple', value))
           WHERE field = 'summary' AND is_current`,
      );

      // Inserts continue with indexes present
      await db.pool.query(
        `INSERT INTO articles (
           external_id, source, published_at, language, headline, body,
           content_hash, flags, search_text, search_text_ver
         ) VALUES (
           'mig7-1', 'fixture', now(), 'en', 'Hello', 'World startup',
           decode(md5('x'), 'hex'), '{}', 'hello world startup', 1
         )`,
      );
      const n = await db.pool.query(`SELECT count(*)::int AS n FROM articles WHERE external_id = 'mig7-1'`);
      expect(n.rows[0].n).toBe(1);

      // Rollback path: drop indexes; inserts still work
      for (const name of REQUIRED) {
        await db.pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      }
      await db.pool.query(
        `INSERT INTO articles (
           external_id, source, published_at, language, headline, body,
           content_hash, flags, search_text, search_text_ver
         ) VALUES (
           'mig7-2', 'fixture', now(), 'en', 'After drop', 'startup funds',
           decode(md5('y'), 'hex'), '{}', 'after drop startup funds', 1
         )`,
      );
      const n2 = await db.pool.query(`SELECT count(*)::int AS n FROM articles WHERE external_id = 'mig7-2'`);
      expect(n2.rows[0].n).toBe(1);
    } finally {
      await db.end();
    }
  }, 120_000);

  it("records build time on a modest seed (FP-DB3)", async () => {
    const db = await createTestDb();
    if (!db) return;
    try {
      await seedArticles(db.pool, { n: 500, seed: 7 });
      for (const name of REQUIRED) {
        await db.pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
      }
      const t0 = performance.now();
      await db.pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_fts_en_idx
           ON articles USING GIN (to_tsvector('english', search_text))
           WHERE split_part(language, '-', 1) IN ('en', 'und')`,
      );
      await db.pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS article_translations_fts_en_idx
           ON article_translations USING GIN (to_tsvector('english', search_text))
           WHERE superseded_at IS NULL`,
      );
      await db.pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS derived_values_summary_fts_en_idx
           ON derived_values USING GIN (to_tsvector('english', value))
           WHERE field = 'summary' AND is_current`,
      );
      await db.pool.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS derived_values_summary_fts_idx
           ON derived_values USING GIN (to_tsvector('simple', value))
           WHERE field = 'summary' AND is_current`,
      );
      const ms = performance.now() - t0;
      expect(ms).toBeLessThan(60_000);
      // eslint-disable-next-line no-console
      console.log(`migration-0007 rebuild on 500-row seed: ${ms.toFixed(0)}ms`);
    } finally {
      await db.end();
    }
  }, 180_000);
});
