import { describe, expect, it } from "vitest";
import { parseQuery, echoAst, compileAst } from "@/lib/search";

describe("query parser", () => {
  it("U-PARSE empty query is ok with null ast", () => {
    const r = parseQuery("");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ast).toBeNull();
  });

  it("U-PARSE G10 precedence OR weaker than AND", () => {
    const r = parseQuery("a OR b AND c");
    expect(r.ok).toBe(true);
    if (r.ok) expect(echoAst(r.ast)).toBe("(a OR (b AND c))");
  });

  it("U-PARSE dangling AND", () => {
    const r = parseQuery("AI AND");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/AND needs a term/);
  });

  it("U-PARSE unbalanced paren", () => {
    const r = parseQuery("(oil");
    expect(r.ok).toBe(false);
  });

  it("U-PARSE AND NOT", () => {
    const r = parseQuery("renewable AND NOT nuclear");
    expect(r.ok).toBe(true);
    if (r.ok) expect(echoAst(r.ast)).toBe("(renewable AND NOT nuclear)");
  });

  it("U-PARSE bare NOT rejected", () => {
    const r = parseQuery("NOT oil");
    expect(r.ok).toBe(false);
  });

  it("U-PARSE compile uses parameters not raw terms in SQL", () => {
    const r = parseQuery(`"oil prices" AND geopolitical`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = compileAst(r.ast);
    expect(c.sql).toBeTruthy();
    expect(c.sql).not.toContain("oil prices");
    expect(c.params.length).toBeGreaterThan(0);
  });

  it("U-PARSE short wildcard rejected", () => {
    const r = parseQuery("a*");
    expect(r.ok).toBe(false);
  });

  it("U-PARSE lowercase and/or/not are terms (keyword case)", () => {
    const r = parseQuery("cats and dogs");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Implicit AND of three terms — lowercase "and" is a search term
    expect(echoAst(r.ast)).toBe("((cats AND and) AND dogs)");
  });

  it("U-PARSE uppercase AND / OR / AND NOT are operators", () => {
    expect(parseQuery("cats AND dogs").ok).toBe(true);
    const or = parseQuery("cats OR dogs");
    expect(or.ok).toBe(true);
    if (or.ok) expect(echoAst(or.ast)).toBe("(cats OR dogs)");
    const not = parseQuery("cats AND NOT dogs");
    expect(not.ok).toBe(true);
    if (not.ok) expect(echoAst(not.ast)).toBe("(cats AND NOT dogs)");
  });

  it("U3 empty_term for tatweel / zero-width / bidi-only (bare, quoted, starred)", () => {
    const cases = [
      "ـ", // tatweel
      "\u200B", // zero-width space
      "\u202A", // LRE bidi
      '"ـ"',
      '"\u200B"',
      "ــ*", // two tatweels + wildcard (length >= 2)
    ];
    for (const q of cases) {
      const r = parseQuery(q);
      expect(r.ok, `expected empty_term for ${JSON.stringify(q)}`).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("empty_term");
        expect(r.error.message).toMatch(/no searchable characters/i);
      }
    }
    expect(parseQuery("عقارات").ok).toBe(true);
    expect(parseQuery("oil").ok).toBe(true);
    expect(parseQuery('"oil prices"').ok).toBe(true);
  });

  it("U-PARSE mixed-case And / oR are terms", () => {
    const and = parseQuery("cats And dogs");
    expect(and.ok).toBe(true);
    if (and.ok) expect(echoAst(and.ast)).toBe("((cats AND And) AND dogs)");
    const or = parseQuery("cats oR dogs");
    expect(or.ok).toBe(true);
    if (or.ok) expect(echoAst(or.ast)).toBe("((cats AND oR) AND dogs)");
  });

  it("U-PARSE nested brackets", () => {
    const r = parseQuery("(a AND (b OR c))");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(echoAst(r.ast)).toBe("(a AND (b OR c))");
  });

  it("U-PARSE quoted phrase and wildcard tokens", () => {
    const phrase = parseQuery('"media intelligence"');
    expect(phrase.ok).toBe(true);
    if (phrase.ok) expect(echoAst(phrase.ast)).toBe('"media intelligence"');
    const wild = parseQuery("renew*");
    expect(wild.ok).toBe(true);
    if (wild.ok) expect(echoAst(wild.ast)).toBe("renew*");
  });

  it("U-PARSE mid-word wildcard and lone star rejected", () => {
    expect(parseQuery("a*b").ok).toBe(false);
    expect(parseQuery("*").ok).toBe(false);
  });
});
