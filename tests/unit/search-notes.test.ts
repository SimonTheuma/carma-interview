import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildSearchText, NORMALISER_VERSION } from "@/lib/normalise";
import { parseQuery } from "@/lib/search";
import { classifyLeaf } from "@/lib/search/leaf";
import type { AstNode } from "@/lib/search/parse";
import { runSearch } from "@/lib/search/run";
import { strings } from "@/lib/ui/strings";

function hasSubstringLeaf(ast: AstNode | null): boolean {
  if (!ast) return false;
  if (ast.type === "term") {
    const opts: { phrase?: boolean; wildcard?: boolean } = {};
    if (ast.phrase) opts.phrase = true;
    if (ast.wildcard) opts.wildcard = true;
    return classifyLeaf(ast.value, opts) === "substring";
  }
  if (ast.type === "and" || ast.type === "or" || ast.type === "and_not") {
    return hasSubstringLeaf(ast.left) || hasSubstringLeaf(ast.right);
  }
  return false;
}

function hasAndNot(ast: AstNode | null): boolean {
  if (!ast) return false;
  if (ast.type === "and_not") return true;
  if (ast.type === "and" || ast.type === "or") {
    return hasAndNot(ast.left) || hasAndNot(ast.right);
  }
  return false;
}

function notesWouldInclude(q: string): { nonLatin: boolean; not: boolean } {
  const parsed = parseQuery(q);
  if (!parsed.ok) return { nonLatin: false, not: false };
  return {
    nonLatin: hasSubstringLeaf(parsed.ast),
    not: hasAndNot(parsed.ast),
  };
}

describe("U5 search echo notes (ADR-0038 / 0040)", () => {
  it("non-Latin note iff at least one substring leaf", () => {
    expect(notesWouldInclude("人工智能").nonLatin).toBe(true);
    expect(notesWouldInclude('"人工智能"').nonLatin).toBe(true);
    expect(notesWouldInclude("科技*").nonLatin).toBe(true);
    expect(notesWouldInclude("oil").nonLatin).toBe(false);
    expect(notesWouldInclude('"NOT"').nonLatin).toBe(false);
  });

  it('NOT note iff AST has and_not — not for quoted word "NOT"', () => {
    expect(notesWouldInclude("renewable AND NOT coal").not).toBe(true);
    expect(notesWouldInclude('"NOT"').not).toBe(false);
    expect(notesWouldInclude("NOTION").not).toBe(false);
    expect(notesWouldInclude("oil AND gas").not).toBe(false);
  });

  it("runSearch emits the note strings when DB is available", async () => {
    const { createTestDb } = await import("../harness/db");
    const db = await createTestDb();
    if (!db) return;

    try {
      const searchText = buildSearchText("Energy", "renewable energy without coal word");
      const hash = createHash("sha256").update(searchText).digest();
      await db.pool.query(
        `INSERT INTO articles (
           external_id, source, published_at, language, headline, body,
           content_hash, flags, search_text, search_text_ver, version
         ) VALUES ('n1','fixture',now(),'en','Energy',$1,$2,'{}',$3,$4,1)`,
        ["renewable energy without coal word", hash, searchText, NORMALISER_VERSION],
      );
      const { refreshCoverageFlags } = await import("@/worker/metrics-refresh");
      await refreshCoverageFlags(db.pool);

      let res = await runSearch(db.pool, { q: "renewable AND NOT coal", limit: 10 });
      expect(res.status).toBe(200);
      const notes = (res.body as { echo_notes: string[] }).echo_notes;
      expect(notes).toContain(strings.notOriginalOnlyNote);

      res = await runSearch(db.pool, { q: '"NOT"', limit: 10 });
      expect(res.status).toBe(200);
      const notesQuoted = (res.body as { echo_notes: string[] }).echo_notes ?? [];
      expect(notesQuoted).not.toContain(strings.notOriginalOnlyNote);

      res = await runSearch(db.pool, { q: "人工智能", limit: 10 });
      expect(res.status).toBe(200);
      expect((res.body as { echo_notes: string[] }).echo_notes).toContain(strings.nonLatinTermNote);
    } finally {
      await db.end();
    }
  }, 60_000);
});
