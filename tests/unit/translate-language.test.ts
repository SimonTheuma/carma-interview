import { describe, expect, it } from "vitest";
import { isEnglish, needsTranslation } from "@/lib/translate/language";
import {
  TRANSLATION_REASON_CODES,
  TRANSLATION_METRIC_LABELS,
  isTranslationReasonCode,
} from "@/lib/translate/reasons";

describe("isEnglish / needsTranslation", () => {
  const english = ["en", "EN", "en-GB", "en_US", "eng", "Eng", "en-Latn-GB"];
  const foreign = ["ar", "zh-Hans", "fr", "de", "es-MX"];
  const unknown = ["", null, undefined, "N/A", "n/a", "null", "   "];

  for (const lang of english) {
    it(`treats ${JSON.stringify(lang)} as English`, () => {
      expect(isEnglish(lang)).toBe(true);
      expect(needsTranslation(lang)).toBe(false);
    });
  }

  for (const lang of foreign) {
    it(`treats ${JSON.stringify(lang)} as needing translation`, () => {
      expect(isEnglish(lang)).toBe(false);
      expect(needsTranslation(lang)).toBe(true);
    });
  }

  for (const lang of unknown) {
    it(`treats ${JSON.stringify(lang)} as needing translation (unknown)`, () => {
      expect(isEnglish(lang)).toBe(false);
      expect(needsTranslation(lang)).toBe(true);
    });
  }
});

describe("translation reason codes", () => {
  it("covers sanitization and telemetry codes", () => {
    const required = [
      "out_echo",
      "out_wrong_lang",
      "out_length",
      "out_chunk_mismatch",
      "out_injected",
      "out_empty",
      "out_bad_text",
      "too_long",
      "attempts",
      "budget_never",
      "not_needed",
      "no_content",
    ];
    for (const code of required) {
      expect(isTranslationReasonCode(code)).toBe(true);
      expect(TRANSLATION_METRIC_LABELS[code as keyof typeof TRANSLATION_METRIC_LABELS]).toBeTruthy();
    }
    expect(TRANSLATION_REASON_CODES.length).toBeGreaterThanOrEqual(required.length);
  });
});
