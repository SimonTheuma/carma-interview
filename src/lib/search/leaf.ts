import { normaliseText } from "../normalise";

/** Match modes for a single term leaf (ADR-0031, 0035, 0036). */
export type LeafKind =
  | "exact"
  | "substring"
  | "phrase"
  | "wildcard";

/** Postgres `english` stop words that yield an empty plainto_tsquery. */
const ENGLISH_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

export function isEnglishStopword(term: string): boolean {
  return ENGLISH_STOPWORDS.has(term.toLocaleLowerCase("en-US"));
}

/**
 * True when the term has any letter that is not Latin-script.
 * Digits, punctuation, and symbols alone do not force substring; Cyrillic/Greek/Hebrew/etc. do.
 * Symbols (`\p{S}`, e.g. `$`, `€`, emoji) are excluded so `$AAPL` stays on Latin rules (ADR-0038).
 */
export function termHasNonLatinLetter(term: string): boolean {
  // Any letter whose script is not Latin → substring path (ADR-0007 / ADR-0038).
  return (
    /\p{L}/u.test(term) && /[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{M}\p{S}]/u.test(term)
  );
}

/**
 * Choose match mode by script first, then quoting / wildcard (ADR-0036, ADR-0038).
 * Any term with a non-Latin letter is substring (bare, quoted, or starred).
 * Bare Latin terms are exact; stemming applies only to Latin `term*`.
 * Quoted single-word Latin phrases are exact; multi-word Latin phrases stay phrase.
 */
export function classifyLeaf(term: string, opts?: { phrase?: boolean; wildcard?: boolean }): LeafKind {
  if (termHasNonLatinLetter(term)) return "substring";
  if (opts?.wildcard) return "wildcard";
  if (opts?.phrase) {
    if (/\s/.test(term.trim())) return "phrase";
    return "exact";
  }
  return "exact";
}

export function escapeIlike(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function normaliseLeafTerm(term: string): string {
  return normaliseText(term);
}

/** Exact expression text must match migration 0007 (FP-DB1). */
export const EXPR = {
  articlesFtsEn: `to_tsvector('english', a.search_text)`,
  articlesLangPred: `split_part(a.language, '-', 1) IN ('en', 'und')`,
  translationsFtsEn: `to_tsvector('english', t.search_text)`,
  summaryFtsEn: `to_tsvector('english', dv.value)`,
  summarySimple: `to_tsvector('simple', dv.value)`,
} as const;
