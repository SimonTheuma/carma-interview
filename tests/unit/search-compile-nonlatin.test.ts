import { describe, expect, it } from "vitest";
import { parseQuery, compileAst } from "@/lib/search";
import { escapeIlike, normaliseLeafTerm } from "@/lib/search/leaf";

function assertAllParamsReferenced(sql: string | null, params: unknown[]) {
  expect(sql).toBeTruthy();
  const all = sql!;
  for (let n = 1; n <= params.length; n++) {
    expect(all).toMatch(new RegExp(`\\$${n}(?!\\d)`));
  }
}

describe("U4 compile non-Latin substring (ADR-0038)", () => {
  it('quoted "人工智能" uses ILIKE ESCAPE with %term%', () => {
    const r = parseQuery('"人工智能"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/ILIKE \$1 ESCAPE/);
    expect(c.params[0]).toBe(`%${escapeIlike(normaliseLeafTerm("人工智能"))}%`);
    expect(c.broadestKind).toBe("nonlatin_sub");
    assertAllParamsReferenced(
      [c.sql, c.originalSql, c.translationSql, c.summarySql].join("\n"),
      c.params,
    );
  });

  it("wildcard 科技* uses substring, not prefix tsquery", () => {
    const r = parseQuery("科技*");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/ILIKE/);
    expect(c.sql).not.toMatch(/to_tsquery\('simple'/);
    expect(c.params[0]).toBe(`%${escapeIlike(normaliseLeafTerm("科技"))}%`);
    expect(c.broadestKind).toBe("nonlatin_sub");
  });

  it("quoted multi-word Chinese phrase collapses whitespace", () => {
    const r = parseQuery('"人工智能  和云计算"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    const expected = normaliseLeafTerm("人工智能  和云计算").replace(/\s+/g, " ").trim();
    expect(c.params[0]).toBe(`%${escapeIlike(expected)}%`);
    expect(c.sql).toMatch(/ILIKE/);
  });

  it("Arabic عقارات uses ILIKE", () => {
    const r = parseQuery("عقارات");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toMatch(/ILIKE \$1 ESCAPE/);
    expect(c.params[0]).toBe(`%${escapeIlike(normaliseLeafTerm("عقارات"))}%`);
  });

  it("escapes %, _, and backslash in substring binds", () => {
    const r = parseQuery('"a%b_c\\d苹果"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    const norm = normaliseLeafTerm("a%b_c\\d苹果").replace(/\s+/g, " ").trim();
    expect(c.params[0]).toBe(`%${escapeIlike(norm)}%`);
    expect(String(c.params[0])).toContain("\\%");
    expect(String(c.params[0])).toContain("\\_");
    expect(String(c.params[0])).toContain("\\\\");
  });

  it("every $n is referenced for mixed non-Latin AND", () => {
    const r = parseQuery('"人工智能" AND عقارات');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    assertAllParamsReferenced(
      [c.sql, c.originalSql, c.translationSql, c.summarySql].join("\n"),
      c.params,
    );
  });
});
