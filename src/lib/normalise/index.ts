import { createHash } from "node:crypto";

export const NORMALISER_VERSION = 1;

const ARABIC_HARAKAT = /[\u064B-\u065F\u0670]/g;
const TATWEEL = /\u0640/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625]/g;
const ALEF_MAQSURA = /\u0649/g;
const TAA_MARBUTA = /\u0629/g;
const BIDI_AND_ZW = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const C0_EXCEPT_WS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** Shared normaliser for index-time search_text and query-time leaves. */
export function normaliseText(input: string): string {
  let s = input.normalize("NFKC");
  s = s.replace(C0_EXCEPT_WS, "");
  s = s.replace(BIDI_AND_ZW, "");
  s = s.replace(ARABIC_HARAKAT, "");
  s = s.replace(TATWEEL, "");
  s = s.replace(ALEF_VARIANTS, "\u0627");
  s = s.replace(ALEF_MAQSURA, "\u064A");
  s = s.replace(TAA_MARBUTA, "\u0647");
  s = s.toLocaleLowerCase("en-US");
  return s;
}

export function buildSearchText(headline: string | null, body: string | null): string {
  const h = headline ? normaliseText(headline) : "";
  const b = body ? normaliseText(body) : "";
  return [h, b].filter(Boolean).join(" ").trim();
}

export function contentHash(headline: string | null, body: string | null): Buffer {
  const payload = `${headline ?? ""}\n${body ?? ""}`;
  return createHash("sha256").update(normaliseText(payload)).digest();
}
