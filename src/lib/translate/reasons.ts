/**
 * Translation reason codes: one enum mapping job reason, metric label, and UI copy key.
 * Sanitization uses out_* forms; telemetry shortens some labels (echo, wrong_lang, …).
 */

export const TRANSLATION_REASON_CODES = [
  "not_needed",
  "no_content",
  "lang_unknown",
  "headline_absent",
  "too_long",
  "out_empty",
  "out_bad_text",
  "out_echo",
  "out_wrong_lang",
  "out_length",
  "out_chunk_mismatch",
  "out_injected",
  "invalid_output",
  "attempts",
  "budget_never",
  "budget_exhausted",
  "kill_switch",
  "circuit_open",
  "provider_timeout",
  "provider_5xx",
  "provider_4xx",
  "permanent_failure",
  "max_attempts",
  "superseded_version",
] as const;

export type TranslationReasonCode = (typeof TRANSLATION_REASON_CODES)[number];

/** Metric label form (telemetry 0003). */
export const TRANSLATION_METRIC_LABELS: Record<TranslationReasonCode, string> = {
  not_needed: "not_needed",
  no_content: "no_content",
  lang_unknown: "lang_unknown",
  headline_absent: "headline_absent",
  too_long: "too_long",
  out_empty: "empty",
  out_bad_text: "bad_text",
  out_echo: "echo",
  out_wrong_lang: "wrong_lang",
  out_length: "length",
  out_chunk_mismatch: "chunk_mismatch",
  out_injected: "injected",
  invalid_output: "invalid_output",
  attempts: "attempts",
  budget_never: "budget_never",
  budget_exhausted: "budget_exhausted",
  kill_switch: "kill_switch",
  circuit_open: "circuit_open",
  provider_timeout: "provider_timeout",
  provider_5xx: "provider_5xx",
  provider_4xx: "provider_4xx",
  permanent_failure: "permanent_failure",
  max_attempts: "max_attempts",
  superseded_version: "superseded_version",
};

/** UI copy keys in src/lib/ui/strings (UX 0003 + C5). */
export const TRANSLATION_UI_COPY_KEYS: Partial<Record<TranslationReasonCode, string>> = {
  too_long: "translation.fail.too_long",
  invalid_output: "translation.fail.quality",
  out_echo: "translation.fail.quality",
  out_wrong_lang: "translation.fail.quality",
  out_length: "translation.fail.quality",
  out_chunk_mismatch: "translation.fail.quality",
  out_empty: "translation.fail.quality",
  out_bad_text: "translation.fail.quality",
  out_injected: "translation.fail.quality",
  permanent_failure: "translation.fail.rejected",
  provider_4xx: "translation.fail.rejected",
  attempts: "translation.fail.attempts",
  max_attempts: "translation.fail.attempts",
  budget_never: "translation.fail.budget_never",
  budget_exhausted: "translation.paused.budget",
  no_content: "translation.no_content",
  kill_switch: "translation.pending",
};

export function isTranslationReasonCode(value: string): value is TranslationReasonCode {
  return (TRANSLATION_REASON_CODES as readonly string[]).includes(value);
}

export function metricLabelFor(reason: TranslationReasonCode): string {
  return TRANSLATION_METRIC_LABELS[reason];
}

export type EnrichmentPart = "sentiment" | "summary_topics" | "translation";
