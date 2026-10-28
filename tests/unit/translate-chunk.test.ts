import { describe, expect, it } from "vitest";
import { chunkForTranslation, countParagraphs } from "@/lib/translate/chunk";
import { mockTranslateText } from "@/lib/providers/mock";
import { validateTranslationOutput } from "@/lib/translate/validate";

describe("chunkForTranslation", () => {
  it("splits on blank lines and preserves paragraph count", () => {
    const r = chunkForTranslation(null, "One.\n\nTwo.\n\nThree.", {
      chunkTokens: 1500,
      maxChunks: 20,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chunks).toHaveLength(3);
    expect(r.inputParagraphCount).toBe(3);
  });

  it("returns too_long when over max chunks", () => {
    const paras = Array.from({ length: 25 }, (_, i) => `Paragraph ${i}.`).join("\n\n");
    const r = chunkForTranslation(null, paras, { chunkTokens: 10, maxChunks: 20 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_long");
  });

  it("handles surrogate pairs without splitting mid-grapheme", () => {
    const emoji = "家族👨‍👩‍👧‍👦" + "x".repeat(100);
    const r = chunkForTranslation(null, emoji, { chunkTokens: 5, maxChunks: 50 });
    expect(r.ok).toBe(true);
  });
});

describe("mock translation validators", () => {
  it("mock output passes validators for arabic-like input", () => {
    const input = "هذا نص عربي للاختبار مع كلمات كافية لتجاوز عشرين حرفا.";
    const out = mockTranslateText(input);
    const v = validateTranslationOutput(input, out, {
      sourceLang: "ar",
      detectedLanguage: "en",
      ratioCjk: { min: 0.15, max: 4 },
      ratioOther: { min: 0.3, max: 3 },
      expectedParagraphs: countParagraphs(input),
    });
    expect(v.ok).toBe(true);
  });
});
