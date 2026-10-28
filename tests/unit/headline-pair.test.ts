import { describe, expect, it } from "vitest";
import { selectHeadlinePair } from "@/lib/translate/headline-pair";
import { strings } from "@/lib/ui/strings";

describe("selectHeadlinePair", () => {
  it("English article: original as primary, no secondary", () => {
    const p = selectHeadlinePair({
      language: "en",
      headline: "Oil rises",
      headlineEn: null,
    });
    expect(p.primary).toBe("Oil rises");
    expect(p.primaryLang).toBe("en");
    expect(p.secondary).toBeNull();
    expect(p.showMachineTranslatedTag).toBe(false);
  });

  it("translated with headline: English primary, original secondary", () => {
    const p = selectHeadlinePair({
      language: "ar",
      headline: "أسعار النفط",
      headlineEn: "Oil prices",
      bodyEn: "Body",
      jobs: [{ part: "translation", state: "succeeded" }],
    });
    expect(p.primary).toBe("Oil prices");
    expect(p.primaryLang).toBe("en");
    expect(p.secondary).toMatch(/Original/);
    expect(p.secondary).toContain("أسعار النفط");
    expect(p.showMachineTranslatedTag).toBe(true);
  });

  it("translated missing headline: original primary with note", () => {
    const p = selectHeadlinePair({
      language: "ar",
      headline: "أسعار",
      headlineEn: null,
      bodyEn: "Body only",
      jobs: [{ part: "translation", state: "succeeded" }],
    });
    expect(p.primary).toBe("أسعار");
    expect(p.note).toBe(strings.headlineNotTranslated);
  });

  it("pending job: original primary with pending note", () => {
    const p = selectHeadlinePair({
      language: "fr",
      headline: "Les prix",
      headlineEn: null,
      jobs: [{ part: "translation", state: "queued" }],
    });
    expect(p.primary).toBe("Les prix");
    expect(p.note).toBe(strings.translationPendingCard);
  });

  it("paused: budget note", () => {
    const p = selectHeadlinePair({
      language: "fr",
      headline: "Les prix",
      headlineEn: null,
      jobs: [{ part: "translation", state: "deferred_budget" }],
    });
    expect(p.note).toBe(strings.translationPausedCard);
  });

  it("dead: unavailable note", () => {
    const p = selectHeadlinePair({
      language: "fr",
      headline: "Les prix",
      headlineEn: null,
      jobs: [{ part: "translation", state: "dead", reason_code: "invalid_output" }],
    });
    expect(p.note).toBe(strings.translationUnavailableCard);
  });

  it("no text to translate", () => {
    const p = selectHeadlinePair({
      language: "de",
      headline: "Titel",
      headlineEn: null,
      jobs: [{ part: "translation", state: "skipped_no_content" }],
    });
    expect(p.note).toBe(strings.translationNoText);
  });

  it("older never scheduled", () => {
    const p = selectHeadlinePair({
      language: "ar",
      headline: "قديم",
      headlineEn: null,
      jobs: [],
    });
    expect(p.note).toBe(strings.notTranslatedOlder);
  });

  it("never empty primary (FP-7)", () => {
    const p = selectHeadlinePair({
      language: "en",
      headline: null,
      headlineEn: null,
    });
    expect(p.primary.trim().length).toBeGreaterThan(0);
  });
});
