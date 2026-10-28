import { detectInjection } from "../enrich/inject-detect";
import { countParagraphs } from "./chunk";
import type { TranslationReasonCode } from "./reasons";

export type ValidateOk = { ok: true; flags: string[] };
export type ValidateFail = { ok: false; reason: TranslationReasonCode };
export type ValidateResult = ValidateOk | ValidateFail;

const EN_STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "with",
  "that",
  "this",
  "as",
  "by",
  "from",
  "it",
  "at",
  "not",
]);

function nfkcCollapse(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function hasNul(s: string): boolean {
  return s.includes("\u0000");
}

function countScriptChars(text: string): { arabic: number; cjk: number; latin: number; total: number } {
  let arabic = 0;
  let cjk = 0;
  let latin = 0;
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (/\s/.test(ch)) continue;
    total++;
    if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f)) arabic++;
    else if (
      (cp >= 0x3400 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    )
      cjk++;
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin++;
  }
  return { arabic, cjk, latin, total: Math.max(1, total) };
}

function letterWordCount(text: string): number {
  const words = text.match(/\p{L}+/gu) ?? [];
  return words.length;
}

function englishStopRatio(text: string): number {
  const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 1);
  if (words.length === 0) return 0;
  let hits = 0;
  for (const w of words) if (EN_STOP.has(w)) hits++;
  return hits / words.length;
}

function sourceScriptFamily(sourceLang: string | null | undefined, input: string): "cjk" | "arabic" | "other" {
  const primary = (sourceLang ?? "").split(/[-_]/)[0]?.toLowerCase() ?? "";
  if (["zh", "ja", "ko", "chi", "jpn", "kor"].includes(primary)) return "cjk";
  if (["ar", "fa", "ur", "he"].includes(primary)) return "arabic";
  const s = countScriptChars(input);
  if (s.cjk / s.total > 0.3) return "cjk";
  if (s.arabic / s.total > 0.3) return "arabic";
  return "other";
}

function extractDigitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

export type ValidateOpts = {
  sourceLang?: string | null;
  detectedLanguage?: string | null;
  ratioCjk: { min: number; max: number };
  ratioOther: { min: number; max: number };
  /** When true, also require paragraph count match against expectedParagraphs. */
  expectedParagraphs?: number;
  /** Source had injection — skip out_injected if source already matched. */
  sourceHadInjection?: boolean;
};

/**
 * Seven output checks in order (sanitization 0003 §4). Linear character scans.
 */
export function validateTranslationOutput(
  input: string,
  output: string,
  opts: ValidateOpts,
): ValidateResult {
  const flags: string[] = [];

  // 1. Parse is caller's job; here we assume strings.
  if (typeof output !== "string") {
    return { ok: false, reason: "invalid_output" };
  }

  // 2. Non-empty
  if (!output.trim()) {
    if (input.trim()) return { ok: false, reason: "out_empty" };
  }
  if (hasNul(output)) return { ok: false, reason: "out_bad_text" };

  // 3. Echo check
  if (input.trim().length > 20) {
    if (nfkcCollapse(input) === nfkcCollapse(output)) {
      if (letterWordCount(input) >= 3) {
        return { ok: false, reason: "out_echo" };
      }
    }
  }

  // 4. Language check
  const family = sourceScriptFamily(opts.sourceLang, input);
  const outScript = countScriptChars(output);
  if (family === "arabic" || family === "cjk") {
    const foreignShare =
      family === "arabic" ? outScript.arabic / outScript.total : outScript.cjk / outScript.total;
    if (foreignShare >= 0.2) return { ok: false, reason: "out_wrong_lang" };
  } else {
    // Latin-script source: stop-word ratio + optional detected_language
    const stop = englishStopRatio(output);
    const detected = (opts.detectedLanguage ?? "").toLowerCase();
    const looksEnglish = stop >= 0.08 || detected.startsWith("en");
    if (output.trim().length > 40 && !looksEnglish) {
      return { ok: false, reason: "out_wrong_lang" };
    }
  }

  // 5. Length ratio
  const inLen = Math.max(1, [...input].length);
  const outLen = [...output].length;
  const ratio = outLen / inLen;
  const bounds = family === "cjk" ? opts.ratioCjk : opts.ratioOther;
  if (ratio < bounds.min || ratio > bounds.max) {
    return { ok: false, reason: "out_length" };
  }

  // 6. Paragraph integrity (whole-text only when expectedParagraphs set)
  if (opts.expectedParagraphs !== undefined) {
    if (countParagraphs(output) !== opts.expectedParagraphs) {
      return { ok: false, reason: "out_chunk_mismatch" };
    }
    const inDigits = new Set(extractDigitRuns(input));
    for (const d of inDigits) {
      if (d.length >= 2 && !output.includes(d)) {
        flags.push("flag_numbers");
        break;
      }
    }
  }

  // 7. Injection-shaped output
  if (!opts.sourceHadInjection && detectInjection(output)) {
    return { ok: false, reason: "out_injected" };
  }

  return { ok: true, flags };
}

export type ParsedTranslate = {
  translation: string;
  detected_language: string;
};

export function parseTranslatePayload(raw: unknown): ParsedTranslate | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.translation !== "string") return null;
  const detected =
    typeof o.detected_language === "string"
      ? o.detected_language
      : typeof o.detectedLanguage === "string"
        ? o.detectedLanguage
        : "";
  return { translation: o.translation, detected_language: detected };
}
