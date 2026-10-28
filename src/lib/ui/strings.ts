export const strings = {
  searchLabel: "Search query",
  searchButton: "Search",
  searching: "Searching…",
  interpretedAs: "Interpreted as:",
  showMore: "Show more results",
  viewTrends: "View trends for this search",
  emptyNoMatch:
    "No articles match this query. Try fewer terms, check the parsed query above, or widen the date range.",
  emptyNotCovered: (total: number, first: string, last: string) =>
    `No articles in the corpus for these filters. The corpus holds ${total} articles from ${first} to ${last} (UTC).`,
  emptyNotProcessed: (n: number) =>
    `${n} articles match your text and date filters but are not enriched yet, so the sentiment/topic filter leaves them out.`,
  serviceError: "Search is temporarily unavailable. Your query and filters are unchanged.",
  tryAgain: "Try again",
  mockOutput: "Mock output",
  aiSummary: "AI summary (automated)",
  why: "Why?",
  noHeadline: "(no headline)",
  clearAll: "Clear all",
  filters: "Filters",
  uploadNav: "Upload",
  uploadTitle: "Upload articles",
  uploadHint: "JSON array of articles. Max {maxBytes} / {maxItems} articles. UTF-8 only.",
  uploadButton: "Upload",
  uploading: "Uploading and checking…",
  uploadFileLabel: "JSON file",
  uploadDisabled: "Upload is disabled on this deployment (kill switch).",
  uploadReconciled: (n: number) => `All ${n} accounted for`,
  uploadNotReconciled: "Counts do not add up — contact an operator with the batch id.",
  quarantineNote:
    "Quarantined articles are kept, not lost, and can be reviewed on the Status page.",
  budgetDeferral:
    "Daily LLM budget reached; these continue after the UTC reset",
  progressStale: "Progress not updating",
  versionHistory: "Version history",
  currentVersion: "Current",
  translationLabel: (language: string) => `Machine translated from ${language}`,
  translationLabelUnknown: "Machine translated",
  originalLabel: (language: string) => `Original text (${language})`,
  showOriginal: "Show original",
  showTranslation: "Show translation",
  liveOriginal: (language: string) => `Showing original text (${language})`,
  liveTranslation: "Showing English translation",
  translationDisclaimer:
    "Automated translation, not reviewed by a person. No confidence score is available.",
  translationAbout: (model: string, date: string, version: string) =>
    `Translated by ${model} on ${date} (prompt ${version}). The original text is the record; this translation is derived from it.`,
  translationLowTrust:
    "This text contained instruction-like content, so the translation may be unreliable.",
  translationPending: "Translation in progress. Showing the original.",
  translationPaused:
    "Translation paused: the daily translation budget is used up. It will continue automatically. Showing the original.",
  translationFailedTooLong:
    "Translation unavailable: the text was too long to translate. Showing the original.",
  translationFailedChecks:
    "Translation unavailable: it did not pass quality checks. Showing the original.",
  translationFailedRejected:
    "Translation unavailable: the translation service rejected the request. Showing the original.",
  translationFailedAttempts:
    "Translation unavailable: the service kept failing. Showing the original.",
  translationFailedBudgetNever:
    "Translation unavailable: it never left the budget queue. Showing the original.",
  translationNoText: "No text to translate.",
  translationLooksEnglish: "This article looks like English; no translation needed.",
  translationLoadError: "Translation could not be loaded. Showing the original.",
  translationMockLabel: "Mock translation (no translation service configured)",
  headlineNotTranslated: "Headline not translated",
  matchedInTranslation: "Matched in translation",
  matchedInBoth: "Matched in original and translation",
  matchedInTranslationMock: "Matched in translation (mock)",
  matchedInTooltip: "The search term was found in the machine translation of this article.",
  matchedInSummary: "Matched in summary",
  matchedInTranslationAndSummary: "Matched in translation and summary",
  matchedInOriginalAndSummary: "Matched in original and summary",
  matchedInSummaryTooltip:
    "The search term was found in the automated summary of this article.",
  machineTranslatedTag: "Machine translated",
  showOriginalText: "Show original text",
  hideOriginalText: "Hide original text",
  showOriginalTextLang: (language: string) => `Show original text (${language})`,
  originalTextLang: (language: string) => `Original text (${language})`,
  originalHeadlineLang: (language: string) => `Original (${language}):`,
  bodyNotTranslated: "Body not translated",
  translationPendingCard: "English translation pending",
  translationPausedCard: "English translation paused: daily budget reached",
  translationUnavailableCard: "English translation unavailable",
  notTranslatedOlder: "Not translated (older article)",
  wildcardTip:
    "Tip: add * to a word to match longer and related forms, for example renew*. Use quotes for an exact phrase.",
  emptyTryWildcard:
    "No exact matches. Try adding * to a word, for example startup*.",
  degradedTrgmNote: "Partial-word matching is running slowly right now.",
  summaryCoverageNote: (n: number) =>
    `${n} articles in this selection have no summary yet, so English terms in summaries may miss them.`,
  emptyTryBroader:
    "Try fewer words, or remove quotes for a broader match",
  untranslatedNote: (n: number) =>
    `Search matches the original text and, where available, the English translation. ${n} foreign-language articles in this selection are not translated yet, so English terms may miss them.`,
  nonLatinTermNote:
    "Terms in Chinese, Arabic and similar scripts match any text containing them, including inside longer words, in the original and the translation.",
  notOriginalOnlyNote: "NOT terms exclude articles by their original text only.",
  checkBackShortly: "Check back shortly.",
} as const;

const REASON_TEXT: Record<string, string> = {
  unauthorized: "Wrong token",
  upload_busy: "Another upload is running, retry in a few seconds",
  rate_limited: "Too many requests, retry later",
  unsupported_media_type: "Use a JSON file (multipart or application/json)",
  file_too_large: "File is larger than the allowed size",
  invalid_encoding: "File is not UTF-8, re-save as UTF-8",
  not_an_array: "Not a JSON array",
  too_many_items: "Too many articles in the file",
  too_deep: "JSON nesting is too deep",
  empty_file: "Empty file",
  upload_disabled: "Upload is disabled",
  db_unavailable: "Database unavailable, retry shortly",
  internal_error: "Something went wrong on the server",
  deadline_exceeded: "The upload did not finish in time",
  new_version: "Content changed; stored as a new version",
  duplicate_id: "Same source and id already stored",
  no_text: "No usable text after cleaning",
  no_content: "No content to enrich",
  payload_invalid: "Not a valid article object",
  missing_required_field: "A required field is missing",
  invalid_json: "Not valid JSON",
  ingest_error: "Ingest failed for this item",
  published_at_no_timezone: "published_at has no timezone",
  markup_removed: "Markup was removed from the text",
  possible_prompt_injection: "Possible prompt-injection phrasing flagged",
  duplicate_content: "Same text as another article",
  headline_absent: "Headline missing",
  superseded_version: "Superseded by a newer version",
  budget_exhausted: "Daily LLM budget reached",
};

export function reasonText(code: string): string {
  return REASON_TEXT[code] ?? code;
}
