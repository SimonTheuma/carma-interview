import { describe, expect, it } from "vitest";
import { createTestDb, seedArticles } from "../harness/db";
import { compileAst, parseQuery } from "@/lib/search";
import { EXPR } from "@/lib/search/leaf";
import type { AstNode } from "@/lib/search/parse";

describe("search plan shape P1–P7 (ADR-0036)", () => {
  it("English indexes used for wildcards only; bare stays simple", async () => {
    const db = await createTestDb();
    if (!db) return;
    const pool = db.pool;

    try {
      await seedArticles(pool, { n: 2000, seed: 99, foreignShare: 0.3 });

      function mustAst(q: string): AstNode {
        const parsed = parseQuery(q);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) throw new Error("parse failed");
        return parsed.ast!;
      }

      async function explain(q: string): Promise<string> {
        const c = compileAst(mustAst(q));
        const sql = `
          EXPLAIN (FORMAT TEXT)
          SELECT a.id FROM articles a
          WHERE (${c.sql})
          ORDER BY a.published_at DESC, a.id DESC
          LIMIT 20`;
        const res = await pool.query(sql, c.params);
        return res.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
      }

      // P1: wildcard uses english FTS expression; plan is index-oriented
      const p1 = await explain("startup*");
      expect(p1).toMatch(/articles_fts_en_idx|Bitmap Index Scan|Bitmap Heap Scan|Index Scan|Index Only Scan/);
      expect(p1.length).toBeGreaterThan(20);
      const cWild = compileAst(mustAst("startup*"));
      expect(cWild.sql).toContain(EXPR.articlesFtsEn);
      expect(cWild.sql).toMatch(/to_tsquery\('simple'/);

      // Bare term must NOT touch english expression (FP-S6)
      const cBare = compileAst(mustAst("startups"));
      expect(cBare.sql).not.toContain(EXPR.articlesFtsEn);
      expect(cBare.sql).toMatch(/plainto_tsquery\('simple'/);
      expect(cBare.broadestKind).toBe("exact");
      const pBare = await explain("startups");
      expect(pBare).not.toMatch(/articles_fts_en_idx/);

      // P2: translation side keeps superseded_at IS NULL
      expect(cWild.translationSql).toMatch(/superseded_at IS NULL/);

      // P3 (Amendment B): bare short term is exact, no ILIKE
      const cAi = compileAst(mustAst("AI"));
      expect(cAi.sql).not.toMatch(/ILIKE/);
      expect(cAi.sql).not.toContain(EXPR.articlesFtsEn);

      // P6: summary side uses both simple and english summary expressions for *
      expect(cWild.summarySql).toMatch(/derived_values/);
      expect(cWild.summarySql).toContain(EXPR.summaryFtsEn);
      expect(cWild.summarySql).toContain(EXPR.summarySimple);

      const cSumExact = compileAst(mustAst("xenonwidget"));
      expect(cSumExact.summarySql).toContain(EXPR.summarySimple);
      expect(cSumExact.summarySql).not.toContain(EXPR.summaryFtsEn);

      // P7: language predicate present for wildcard stem half only (FP-DB1)
      expect(cWild.originalSql).toContain("split_part(a.language, '-', 1) IN ('en', 'und')");
      expect(cBare.originalSql).not.toContain("split_part(a.language, '-', 1) IN ('en', 'und')");
      expect(cWild.originalSql).not.toContain("split_part(a.language, '-', 1) IN ('en')");
    } finally {
      await db.end();
    }
  }, 300_000);
});
