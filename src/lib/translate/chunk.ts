export type ChunkResult =
  | { ok: true; chunks: string[]; inputParagraphCount: number }
  | { ok: false; reason: "too_long" | "no_content" };

/** Rough token estimate: CJK ~1 char/token, else ~4 chars/token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return cjk + Math.ceil(other / 4);
}

const SENTENCE_SPLIT = /(?<=[.!?。！？؟\n])\s*/u;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function graphemeSafeSlice(text: string, maxChars: number): [string, string] {
  if (text.length <= maxChars) return [text, ""];
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let acc = "";
    let rest = "";
    let startedRest = false;
    for (const { segment } of seg.segment(text)) {
      if (!startedRest && acc.length + segment.length <= maxChars) {
        acc += segment;
      } else {
        startedRest = true;
        rest += segment;
      }
    }
    if (acc.length === 0 && text.length > 0) {
      // Single oversized grapheme — force one code point
      const cp = text.codePointAt(0)!;
      const first = String.fromCodePoint(cp);
      return [first, text.slice(first.length)];
    }
    return [acc, rest];
  } catch {
    return [text.slice(0, maxChars), text.slice(maxChars)];
  }
}

function splitOversizedParagraph(para: string, maxTokens: number): string[] {
  if (estimateTokens(para) <= maxTokens) return [para];
  const sentences = para.split(SENTENCE_SPLIT).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const candidate = buf ? `${buf} ${s}` : s;
    if (estimateTokens(candidate) <= maxTokens) {
      buf = candidate;
    } else {
      if (buf) out.push(buf);
      if (estimateTokens(s) <= maxTokens) {
        buf = s;
      } else {
        // Grapheme-safe hard split
        let remaining = s;
        while (estimateTokens(remaining) > maxTokens) {
          const approxChars = Math.max(1, Math.floor(maxTokens * 4));
          const [head, tail] = graphemeSafeSlice(remaining, approxChars);
          if (head) out.push(head);
          remaining = tail;
          if (!head) break;
        }
        buf = remaining;
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Split headline+body into translation chunks on paragraph boundaries.
 * Oversized paragraphs split at sentence then grapheme boundaries.
 */
export function chunkForTranslation(
  headline: string | null,
  body: string | null,
  opts: { chunkTokens: number; maxChunks: number },
): ChunkResult {
  const parts: string[] = [];
  if (headline?.trim()) parts.push(headline.trim());
  if (body?.trim()) parts.push(...splitParagraphs(body));
  if (parts.length === 0) return { ok: false, reason: "no_content" };

  const inputParagraphCount = parts.length;
  const pieces: string[] = [];
  for (const p of parts) {
    pieces.push(...splitOversizedParagraph(p, opts.chunkTokens));
  }

  if (pieces.length > opts.maxChunks) {
    return { ok: false, reason: "too_long" };
  }
  return { ok: true, chunks: pieces, inputParagraphCount };
}

/** Count paragraphs the same way as the chunker (blank-line split). */
export function countParagraphs(text: string): number {
  return splitParagraphs(text).length;
}
