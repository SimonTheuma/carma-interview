import { describe, expect, it } from "vitest";
import { classifyLeaf, termHasNonLatinLetter } from "@/lib/search/leaf";

/** Scripts that must classify as substring in every term form (U1). */
const NON_LATIN_SAMPLES: { script: string; bare: string; multi: string }[] = [
  { script: "Han", bare: "人工智能", multi: "人工智能 云计算" },
  { script: "Hiragana", bare: "ひらがな", multi: "ひらがな てすと" },
  { script: "Katakana", bare: "カタカナ", multi: "カタカナ テスト" },
  { script: "Hangul", bare: "한글", multi: "한글 테스트" },
  { script: "Arabic", bare: "عقارات", multi: "عقارات سكنية" },
  { script: "Hebrew", bare: "שלום", multi: "שלום עולם" },
  { script: "Cyrillic", bare: "нефть", multi: "нефть цены" },
  { script: "Greek", bare: "ενέργεια", multi: "ενέργεια τιμή" },
  { script: "Devanagari", bare: "नमस्ते", multi: "नमस्ते दुनिया" },
  { script: "Thai", bare: "สวัสดี", multi: "สวัสดี โลก" },
];

describe("U1 classifyLeaf script-first (ADR-0038)", () => {
  for (const sample of NON_LATIN_SAMPLES) {
    it(`${sample.script}: bare / quoted / multi / starred → substring`, () => {
      expect(termHasNonLatinLetter(sample.bare)).toBe(true);
      expect(classifyLeaf(sample.bare)).toBe("substring");
      expect(classifyLeaf(sample.bare, { phrase: true })).toBe("substring");
      expect(classifyLeaf(sample.multi, { phrase: true })).toBe("substring");
      expect(classifyLeaf(sample.bare, { wildcard: true })).toBe("substring");
    });
  }

  it("mixed Latin/non-Latin → substring", () => {
    expect(classifyLeaf("iPhone苹果")).toBe("substring");
    expect(classifyLeaf("iPhone苹果", { phrase: true })).toBe("substring");
    expect(classifyLeaf("iPhone苹果", { wildcard: true })).toBe("substring");
  });

  it("accented Latin stays on Latin rules", () => {
    expect(termHasNonLatinLetter("café")).toBe(false);
    expect(classifyLeaf("café")).toBe("exact");
    expect(classifyLeaf("café", { phrase: true })).toBe("exact");
    expect(classifyLeaf("café", { wildcard: true })).toBe("wildcard");
  });

  it("digits-only stay on Latin rules", () => {
    expect(termHasNonLatinLetter("2026")).toBe(false);
    expect(classifyLeaf("2026")).toBe("exact");
  });

  it("symbols do not force substring (\\p{S} excluded)", () => {
    expect(termHasNonLatinLetter("$AAPL")).toBe(false);
    expect(classifyLeaf("$AAPL")).toBe("exact");
    expect(termHasNonLatinLetter("€")).toBe(false);
    expect(classifyLeaf("€")).toBe("exact");
    expect(termHasNonLatinLetter("🚀")).toBe(false);
    expect(classifyLeaf("🚀")).toBe("exact");
  });
});

describe("U2 Latin regression (ADR-0036)", () => {
  it('"startup" → exact', () => {
    expect(classifyLeaf("startup", { phrase: true })).toBe("exact");
  });

  it("startup* → wildcard", () => {
    expect(classifyLeaf("startup", { wildcard: true })).toBe("wildcard");
  });

  it('"oil prices" → phrase', () => {
    expect(classifyLeaf("oil prices", { phrase: true })).toBe("phrase");
  });

  it("bare Latin → exact", () => {
    expect(classifyLeaf("renewable")).toBe("exact");
  });
});
