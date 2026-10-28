import { describe, expect, it } from "vitest";
import { shiftPlaceholders } from "@/app/api/aggregate/route";
import { parseQuery, compileAst, buildFilterClauses } from "@/lib/search";

describe("aggregate placeholder binding (S2 / empty trends q)", () => {
  it("shiftPlaceholders bumps $n by the given offset", () => {
    expect(shiftPlaceholders("a.search_text ILIKE $1 AND a.id = $2", 2)).toBe(
      "a.search_text ILIKE $3 AND a.id = $4",
    );
    expect(shiftPlaceholders("WHERE true", 2)).toBe("WHERE true");
    expect(shiftPlaceholders("$1 $10 $2", 2)).toBe("$3 $12 $4");
  });

  it("empty query yields WHERE true with zero where-params", () => {
    const parsed = parseQuery("");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const compiled = compileAst(parsed.ast, 1);
    const fb = buildFilterClauses({}, compiled.params.length + 1);
    const whereParts: string[] = [];
    if (compiled.sql) whereParts.push(`(${compiled.sql})`);
    whereParts.push(...fb.clauses);
    const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "WHERE true";
    const whereParams = [...compiled.params, ...fb.params];
    expect(where).toBe("WHERE true");
    expect(whereParams).toHaveLength(0);
    // Series still prepends nullable from/to as $1/$2
    const seriesParams = [null, null, ...whereParams];
    expect(seriesParams).toHaveLength(2);
    expect(shiftPlaceholders(where, 2)).toBe("WHERE true");
  });

  it("term query where-params align with shifted series placeholders", () => {
    const parsed = parseQuery("oil");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const compiled = compileAst(parsed.ast, 1);
    expect(compiled.params.length).toBeGreaterThan(0);
    const whereForSeries = shiftPlaceholders(`(${compiled.sql})`, 2);
    expect(whereForSeries).toMatch(/\$3/);
    expect(whereForSeries).not.toMatch(/\$1(?!\d)/);
  });
});
