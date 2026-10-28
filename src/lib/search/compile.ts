import { counter } from "../metrics";
import type { AstNode } from "./parse";
import {
  classifyLeaf,
  escapeIlike,
  EXPR,
  isEnglishStopword,
  normaliseLeafTerm,
} from "./leaf";

const emptyStem = counter(
  "mss_search_empty_stem_total",
  "Stop-word wildcards that omitted the English stem half",
);

export type CompiledQuery = {
  sql: string | null;
  params: unknown[];
  /** Original-side-only predicate (same param indices as sql). */
  originalSql: string | null;
  /** Translation-side EXISTS predicate (same param indices as sql). */
  translationSql: string | null;
  /** Summary-side EXISTS predicate (same param indices as sql). */
  summarySql: string | null;
  /** Broadest term kind in the query for telemetry (ADR-0036). */
  broadestKind: "exact" | "wildcard" | "nonlatin_sub" | "none";
};

type Side = "both" | "original" | "translation" | "summary";

type TermMeta = {
  key: string;
  value: unknown;
  kind: ReturnType<typeof classifyLeaf>;
  /** When stem is empty (stop-word wildcard), omit the stem half. */
  stemEmpty: boolean;
  /** Sanitised stem text for wildcard english half (plainto_tsquery). */
  stemValue?: string;
};

/**
 * Compile AST to a SQL boolean fragment.
 * Positive term leaves match original OR current translation OR current summary (ADR-0035).
 * Bare/quoted Latin terms are exact on the simple vector; `term*` is prefix OR English stem (ADR-0036).
 * The right side of `and_not` matches the original only (ADR-0027).
 */
export function compileAst(ast: AstNode | null, startIndex = 1): CompiledQuery {
  if (!ast) {
    return {
      sql: null,
      params: [],
      originalSql: null,
      translationSql: null,
      summarySql: null,
      broadestKind: "none",
    };
  }

  const params: unknown[] = [];
  let next = startIndex;
  const indexByKey = new Map<string, number>();
  const metaByNode = new WeakMap<object, TermMeta>();
  let broadestKind: CompiledQuery["broadestKind"] = "exact";

  function widenKind(k: TermMeta["kind"]) {
    if (k === "substring") {
      broadestKind = "nonlatin_sub";
      return;
    }
    if (k === "wildcard") {
      if (broadestKind !== "nonlatin_sub") broadestKind = "wildcard";
      return;
    }
    // exact / phrase stay at exact unless already wider
  }

  function paramIndex(key: string, value: unknown): number {
    const existing = indexByKey.get(key);
    if (existing !== undefined) return existing;
    params.push(value);
    const i = next;
    next++;
    indexByKey.set(key, i);
    return i;
  }

  function termMeta(node: Extract<AstNode, { type: "term" }>): TermMeta {
    const cached = metaByNode.get(node);
    if (cached) return cached;

    const classifyOpts: { phrase?: boolean; wildcard?: boolean } = {};
    if (node.phrase) classifyOpts.phrase = true;
    if (node.wildcard) classifyOpts.wildcard = true;
    const kind = classifyLeaf(node.value, classifyOpts);
    let norm = normaliseLeafTerm(node.value);
    // Collapse whitespace so phrase spacing matches stored search_text (ADR-0038 / FP-2).
    if (kind === "substring") {
      norm = norm.replace(/\s+/g, " ").trim();
    }
    const stemEmpty = kind === "wildcard" && isEnglishStopword(norm);
    if (stemEmpty) emptyStem.inc();
    widenKind(kind);

    let meta: TermMeta;
    if (kind === "substring") {
      meta = { key: `sub:${norm}`, value: `%${escapeIlike(norm)}%`, kind, stemEmpty };
    } else if (kind === "phrase") {
      meta = { key: `phrase:${norm}`, value: norm, kind, stemEmpty };
    } else if (kind === "wildcard") {
      const safe = norm.replace(/[^\p{L}\p{N}]+/gu, "");
      meta = {
        key: `wild:${safe}`,
        value: `${safe}:*`,
        kind,
        stemEmpty,
        stemValue: safe,
      };
    } else {
      meta = { key: `exact:${norm}`, value: norm, kind, stemEmpty };
    }
    metaByNode.set(node, meta);
    return meta;
  }

  function translationExists(predicate: string): string {
    return `EXISTS (SELECT 1 FROM article_translations t
      WHERE t.article_id = a.id
        AND t.article_version = a.version
        AND t.superseded_at IS NULL
        AND (${predicate}))`;
  }

  function summaryExists(predicate: string): string {
    return `EXISTS (SELECT 1 FROM derived_values dv
      WHERE dv.article_id = a.id
        AND dv.field = 'summary'
        AND dv.is_current
        AND (${predicate}))`;
  }

  function origStem(idx: number): string {
    return `(${EXPR.articlesLangPred} AND ${EXPR.articlesFtsEn} @@ plainto_tsquery('english', $${idx}))`;
  }

  function origSub(idx: number): string {
    return `a.search_text ILIKE $${idx} ESCAPE '\\'`;
  }

  function origExact(idx: number): string {
    return `a.search_vector @@ plainto_tsquery('simple', $${idx})`;
  }

  function origPhrase(idx: number): string {
    return `a.search_vector @@ phraseto_tsquery('simple', $${idx})`;
  }

  function origWild(idx: number): string {
    return `a.search_vector @@ to_tsquery('simple', $${idx})`;
  }

  function trStem(idx: number): string {
    return `${EXPR.translationsFtsEn} @@ plainto_tsquery('english', $${idx})`;
  }

  function trSub(idx: number): string {
    return `t.search_text ILIKE $${idx} ESCAPE '\\'`;
  }

  function trExact(idx: number): string {
    return `t.search_vector @@ plainto_tsquery('simple', $${idx})`;
  }

  function trPhrase(idx: number): string {
    return `t.search_vector @@ phraseto_tsquery('simple', $${idx})`;
  }

  function trWild(idx: number): string {
    return `t.search_vector @@ to_tsquery('simple', $${idx})`;
  }

  function sumStem(idx: number): string {
    return `${EXPR.summaryFtsEn} @@ plainto_tsquery('english', $${idx})`;
  }

  function sumSub(idx: number): string {
    return `dv.value ILIKE $${idx} ESCAPE '\\'`;
  }

  function sumExact(idx: number): string {
    return `${EXPR.summarySimple} @@ plainto_tsquery('simple', $${idx})`;
  }

  function sumPhrase(idx: number): string {
    return `${EXPR.summarySimple} @@ phraseto_tsquery('simple', $${idx})`;
  }

  function sumWild(idx: number): string {
    return `${EXPR.summarySimple} @@ to_tsquery('simple', $${idx})`;
  }

  function compileWildcard(meta: TermMeta, side: Side): string {
    const prefixIdx = paramIndex(meta.key, meta.value);

    if (meta.stemEmpty) {
      // Prefix only — do not bind an unused stem param (FP-S7).
      if (side === "original") return origWild(prefixIdx);
      if (side === "translation") return translationExists(trWild(prefixIdx));
      if (side === "summary") return summaryExists(sumWild(prefixIdx));
      return `(${origWild(prefixIdx)} OR ${translationExists(trWild(prefixIdx))} OR ${summaryExists(sumWild(prefixIdx))})`;
    }

    const stemIdx = paramIndex(`stem_of:${meta.key}`, meta.stemValue ?? meta.value);
    const orig = `(${origWild(prefixIdx)} OR ${origStem(stemIdx)})`;
    const tr = `(${trWild(prefixIdx)} OR ${trStem(stemIdx)})`;
    const sum = `(${sumWild(prefixIdx)} OR ${sumStem(stemIdx)})`;

    if (side === "original") return orig;
    if (side === "translation") return translationExists(tr);
    if (side === "summary") return summaryExists(sum);
    return `(${orig} OR ${translationExists(tr)} OR ${summaryExists(sum)})`;
  }

  function compileTerm(node: Extract<AstNode, { type: "term" }>, side: Side): string {
    const meta = termMeta(node);

    if (meta.kind === "substring") {
      const idx = paramIndex(meta.key, meta.value);
      if (side === "original") return origSub(idx);
      if (side === "translation") return translationExists(trSub(idx));
      if (side === "summary") return summaryExists(sumSub(idx));
      return `(${origSub(idx)} OR ${translationExists(trSub(idx))} OR ${summaryExists(sumSub(idx))})`;
    }

    if (meta.kind === "phrase") {
      const idx = paramIndex(meta.key, meta.value);
      if (side === "original") return origPhrase(idx);
      if (side === "translation") return translationExists(trPhrase(idx));
      if (side === "summary") return summaryExists(sumPhrase(idx));
      return `(${origPhrase(idx)} OR ${translationExists(trPhrase(idx))} OR ${summaryExists(sumPhrase(idx))})`;
    }

    if (meta.kind === "wildcard") {
      return compileWildcard(meta, side);
    }

    // exact (bare or quoted single word)
    const idx = paramIndex(meta.key, meta.value);
    if (side === "original") return origExact(idx);
    if (side === "translation") return translationExists(trExact(idx));
    if (side === "summary") return summaryExists(sumExact(idx));
    return `(${origExact(idx)} OR ${translationExists(trExact(idx))} OR ${summaryExists(sumExact(idx))})`;
  }

  function compile(node: AstNode, side: Side): string {
    switch (node.type) {
      case "and":
        return `(${compile(node.left, side)}) AND (${compile(node.right, side)})`;
      case "or":
        return `(${compile(node.left, side)}) OR (${compile(node.right, side)})`;
      case "and_not":
        // NOT never uses translation or summary (ADR-0027, ADR-0035)
        if (side === "translation" || side === "summary") return compile(node.left, side);
        if (side === "original") {
          return `(${compile(node.left, "original")}) AND NOT (${compile(node.right, "original")})`;
        }
        return `(${compile(node.left, "both")}) AND NOT (${compile(node.right, "original")})`;
      case "term":
        return compileTerm(node, side);
    }
  }

  // Register params by walking "both" first (visits every term once in order).
  const sql = compile(ast, "both");
  const originalSql = compile(ast, "original");
  const translationSql = compile(ast, "translation");
  const summarySql = compile(ast, "summary");

  return { sql, params, originalSql, translationSql, summarySql, broadestKind };
}
