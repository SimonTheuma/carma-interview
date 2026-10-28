/** Enumerated reason and flag codes used across ingest, enrichment and APIs. */

export const FLAG_CODES = [
  "markup_removed",
  "possible_prompt_injection",
  "duplicate_content",
  "headline_absent",
  "truncated_for_enrichment",
  "estimated_cost",
  "new_version",
  "lang_unknown",
  "flag_numbers",
  "replaced_invalid_utf8",
] as const;

export type FlagCode = (typeof FLAG_CODES)[number];

export const REASON_CODES = [
  "invalid_json",
  "missing_required_field",
  "empty_after_sanitise",
  "oversized_payload",
  "unsupported_encoding",
  "nul_or_control",
  "provider_timeout",
  "provider_5xx",
  "provider_4xx",
  "invalid_output",
  "budget_exhausted",
  "kill_switch",
  "no_content",
  "circuit_open",
  "permanent_failure",
  "max_attempts",
  "new_version",
  "superseded_version",
  "duplicate_id",
  "no_text",
  "ingest_error",
  "payload_invalid",
  // Upload gate / route
  "unauthorized",
  "upload_busy",
  "rate_limited",
  "unsupported_media_type",
  "file_too_large",
  "invalid_encoding",
  "not_an_array",
  "too_many_items",
  "too_deep",
  "empty_file",
  "upload_disabled",
  "db_unavailable",
  "internal_error",
  "deadline_exceeded",
  // Translation (see also src/lib/translate/reasons.ts)
  "not_needed",
  "too_long",
  "out_empty",
  "out_bad_text",
  "out_echo",
  "out_wrong_lang",
  "out_length",
  "out_chunk_mismatch",
  "out_injected",
  "attempts",
  "budget_never",
  "lang_unknown",
  "headline_absent",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export function isFlagCode(value: string): value is FlagCode {
  return (FLAG_CODES as readonly string[]).includes(value);
}

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}
