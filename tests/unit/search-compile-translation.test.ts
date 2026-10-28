import { describe, expect, it } from "vitest";
import { parseQuery, compileAst } from "@/lib/search";
import { EXPR } from "@/lib/search/leaf";

describe("compileAst exact / wildcard / summary (ADR-0036)", () => {
  it("bare Latin term uses simple exact only (no english stem, no ILIKE)", () => {
    const r = parseQuery("startups");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/plainto_tsquery\('simple'/);
    expect(c.sql).not.toContain(EXPR.articlesFtsEn);
    expect(c.sql).not.toContain("plainto_tsquery('english'");
    expect(c.sql).not.toMatch(/ILIKE/);
    expect(c.sql).toMatch(/article_translations/);
    expect(c.sql).toMatch(/derived_values/);
    expect(c.sql).toContain("field = 'summary'");
    expect(c.originalSql).toMatch(/plainto_tsquery\('simple'/);
    expect(c.translationSql).toMatch(/EXISTS/);
    expect(c.summarySql).toMatch(/EXISTS/);
    expect(c.broadestKind).toBe("exact");
    expect(c.sql).not.toMatch(/plainto_tsquery\('simple',\s*'startups'/);
  });

  it("quoted term uses simple exact, not english stem", () => {
    const r = parseQuery('"startup"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/plainto_tsquery\('simple'/);
    expect(c.sql).not.toContain(EXPR.articlesFtsEn);
    expect(c.broadestKind).toBe("exact");
  });

  it("quoted phrase uses phraseto_tsquery simple", () => {
    const r = parseQuery('"venture capital"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/phraseto_tsquery\('simple'/);
  });

  it("wildcard uses simple prefix OR english stem", () => {
    const r = parseQuery("renew*");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/to_tsquery\('simple'/);
    expect(c.sql).toContain(EXPR.articlesFtsEn);
    expect(c.sql).toContain(EXPR.articlesLangPred);
    expect(c.sql).toContain("plainto_tsquery('english'");
    expect(c.broadestKind).toBe("wildcard");
    expect(c.params.length).toBeGreaterThanOrEqual(2);
  });

  it("stop-word wildcard omits stem half and unused binds", () => {
    const r = parseQuery("the*");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/to_tsquery\('simple'/);
    expect(c.sql).not.toContain("plainto_tsquery('english'");
    expect(c.broadestKind).toBe("wildcard");
    const allSql = [c.sql, c.originalSql, c.translationSql, c.summarySql].join("\n");
    for (let n = 1; n <= c.params.length; n++) {
      expect(allSql).toMatch(new RegExp(`\\$${n}(?!\\d)`));
    }
  });

  it("short bare term is exact (not stemmed)", () => {
    const r = parseQuery("AI");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/plainto_tsquery\('simple'/);
    expect(c.sql).not.toContain(EXPR.articlesFtsEn);
    expect(c.sql).not.toMatch(/ILIKE/);
    expect(c.broadestKind).toBe("exact");
  });

  it("bare stop word is exact simple (not substring)", () => {
    const r = parseQuery("the");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/plainto_tsquery\('simple'/);
    expect(c.sql).not.toMatch(/ILIKE/);
    expect(c.sql).not.toContain("plainto_tsquery('english'");
  });

  it("every bind parameter is referenced in compiled SQL", () => {
    const queries = [
      "the",
      "startups",
      "startups AND oil",
      '"startup"',
      "AI",
      "renew*",
      "the*",
      "العقارات",
      "стартап",
    ];
    for (const q of queries) {
      const r = parseQuery(q);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const c = compileAst(r.ast);
      const allSql = [c.sql, c.originalSql, c.translationSql, c.summarySql].join("\n");
      for (let n = 1; n <= c.params.length; n++) {
        expect(
          allSql,
          `missing $${n} for query ${JSON.stringify(q)}`,
        ).toMatch(new RegExp(`\\$${n}(?!\\d)`));
      }
    }
  });

  it("Cyrillic term uses substring only (no english stem)", () => {
    const r = parseQuery("стартап");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/ILIKE/);
    expect(c.sql).not.toContain(EXPR.articlesFtsEn);
    expect(c.sql).not.toContain("plainto_tsquery('english'");
    expect(c.broadestKind).toBe("nonlatin_sub");
  });

  it("compiles NOT against original only (no summary, no translation in NOT)", () => {
    const r = parseQuery("oil AND NOT coal");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/AND NOT/);
    const notPart = c.sql!.split("AND NOT")[1] ?? "";
    expect(notPart).not.toMatch(/article_translations/);
    expect(notPart).not.toMatch(/derived_values/);
  });

  it("NOT with wildcard uses prefix OR stem on original only", () => {
    const r = parseQuery("oil AND NOT renew*");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    const notPart = c.sql!.split("AND NOT")[1] ?? "";
    expect(notPart).toMatch(/to_tsquery\('simple'/);
    expect(notPart).toContain(EXPR.articlesFtsEn);
    expect(notPart).not.toMatch(/article_translations/);
    expect(notPart).not.toMatch(/derived_values/);
  });

  it("substring leaves use ILIKE on all three sides", () => {
    const r = parseQuery("العقارات");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/ILIKE/);
    expect(c.translationSql).toMatch(/t\.search_text ILIKE/);
    expect(c.summarySql).toMatch(/dv\.value ILIKE/);
    expect(c.broadestKind).toBe("nonlatin_sub");
  });

  it("AND / OR preserve per-term rules", () => {
    const r = parseQuery("startups AND oil");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/AND/);
    expect(c.params.length).toBeGreaterThanOrEqual(2);
    expect(c.broadestKind).toBe("exact");
  });

  it("expression text snapshot equals migration index expression", () => {
    expect(EXPR.articlesFtsEn).toBe("to_tsvector('english', a.search_text)");
    expect(EXPR.articlesLangPred).toBe("split_part(a.language, '-', 1) IN ('en', 'und')");
    expect(EXPR.translationsFtsEn).toBe("to_tsvector('english', t.search_text)");
    expect(EXPR.summaryFtsEn).toBe("to_tsvector('english', dv.value)");
    expect(EXPR.summarySimple).toBe("to_tsvector('simple', dv.value)");
  });
});
