import { strings } from "../ui/strings";
import { isEnglish, needsTranslation } from "./language";
import { languageDisplayName, selectTranslationPageState } from "./display";

export type HeadlinePair = {
  primary: string;
  primaryLang: string;
  secondary: string | null;
  secondaryLang: string | null;
  note: string | null;
  showMachineTranslatedTag: boolean;
};

type Job = { part: string; state: string; reason_code?: string | null };

/**
 * English-first headline selection for cards and article page (ADR-0032, UX 0004 §5.2).
 * Never returns an empty primary (FP-7).
 */
export function selectHeadlinePair(opts: {
  language: string | null;
  headline: string | null;
  headlineEn: string | null | undefined;
  bodyEn?: string | null;
  jobs?: Job[];
}): HeadlinePair {
  const lang = opts.language ?? "und";
  const original = (opts.headline ?? "").trim() || strings.noHeadline;
  const headlineEn = opts.headlineEn?.trim() || null;
  const langName = languageDisplayName(lang);
  const originalLabel = `Original (${langName}):`;

  if (isEnglish(lang) || !needsTranslation(lang)) {
    return {
      primary: original,
      primaryLang: lang,
      secondary: null,
      secondaryLang: null,
      note: null,
      showMachineTranslatedTag: false,
    };
  }

  const trJob = opts.jobs?.find((j) => j.part === "translation") ?? null;
  const state = selectTranslationPageState({
    language: lang,
    translationRow:
      headlineEn || opts.bodyEn
        ? {
            headline_en: headlineEn,
            body_en: opts.bodyEn ?? null,
          }
        : null,
    job: trJob
      ? { state: trJob.state, reason_code: trJob.reason_code ?? null }
      : null,
    enrichment: null,
  });

  if (state.kind === "translated") {
    if (headlineEn) {
      return {
        primary: headlineEn,
        primaryLang: "en",
        secondary: `${originalLabel} ${opts.headline?.trim() || strings.noHeadline}`,
        secondaryLang: lang,
        note: null,
        showMachineTranslatedTag: true,
      };
    }
    // Translated but headline missing in translation
    return {
      primary: original,
      primaryLang: lang,
      secondary: null,
      secondaryLang: null,
      note: strings.headlineNotTranslated,
      showMachineTranslatedTag: true,
    };
  }

  const noteFor = (): string => {
    switch (state.kind) {
      case "pending":
        return !trJob ? strings.notTranslatedOlder : strings.translationPendingCard;
      case "paused":
        return strings.translationPausedCard;
      case "failed":
        return strings.translationUnavailableCard;
      case "no_content":
        return strings.translationNoText;
      default:
        return strings.translationPendingCard;
    }
  };

  return {
    primary: original,
    primaryLang: lang,
    secondary: null,
    secondaryLang: null,
    note: noteFor(),
    showMachineTranslatedTag: false,
  };
}
