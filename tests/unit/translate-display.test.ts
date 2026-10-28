import { describe, expect, it } from "vitest";
import { selectTranslationPageState } from "@/lib/translate/display";

describe("selectTranslationPageState", () => {
  it("not_needed for English", () => {
    expect(
      selectTranslationPageState({
        language: "en-GB",
        translationRow: null,
        job: null,
        enrichment: null,
      }).kind,
    ).toBe("not_needed");
  });

  it("translated with low trust", () => {
    const s = selectTranslationPageState({
      language: "ar",
      translationRow: { headline_en: "Hi", body_en: "Body", flags: [] },
      job: { state: "succeeded", reason_code: null },
      enrichment: { trust: "low", origin: "provider" },
    });
    expect(s).toEqual({ kind: "translated", lowTrust: true, mock: false });
  });

  it("pending / paused / failed / no_content", () => {
    expect(
      selectTranslationPageState({
        language: "fr",
        translationRow: null,
        job: { state: "queued", reason_code: null },
        enrichment: null,
      }).kind,
    ).toBe("pending");
    expect(
      selectTranslationPageState({
        language: "fr",
        translationRow: null,
        job: { state: "deferred_budget", reason_code: "budget_exhausted" },
        enrichment: null,
      }).kind,
    ).toBe("paused");
    expect(
      selectTranslationPageState({
        language: "fr",
        translationRow: null,
        job: { state: "dead", reason_code: "too_long" },
        enrichment: null,
      }),
    ).toEqual({ kind: "failed", reason: "too_long" });
    expect(
      selectTranslationPageState({
        language: "fr",
        translationRow: null,
        job: { state: "skipped_no_content", reason_code: "no_content" },
        enrichment: null,
      }).kind,
    ).toBe("no_content");
  });

  it("load_error when query failed", () => {
    expect(
      selectTranslationPageState({
        language: "ar",
        translationRow: null,
        job: null,
        enrichment: null,
        loadFailed: true,
      }).kind,
    ).toBe("load_error");
  });
});
