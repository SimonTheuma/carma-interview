import { isEnglish, needsTranslation } from "./language";

export function languageDisplayName(code: string | null | undefined): string {
  if (!code?.trim()) return "unknown";
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const primary = code.trim().split(/[-_]/)[0]!;
    return dn.of(primary) ?? code;
  } catch {
    return code;
  }
}

export type TranslationPageState =
  | { kind: "not_needed" }
  | { kind: "translated"; lowTrust: boolean; mock: boolean }
  | { kind: "pending" }
  | { kind: "paused" }
  | { kind: "failed"; reason: string }
  | { kind: "no_content" }
  | { kind: "looks_english" }
  | { kind: "load_error" };

export function selectTranslationPageState(opts: {
  language: string | null;
  translationRow: {
    headline_en: string | null;
    body_en: string | null;
    flags?: string[] | null;
  } | null;
  job: { state: string; reason_code: string | null } | null;
  enrichment: { trust: string; origin: string } | null;
  loadFailed?: boolean;
}): TranslationPageState {
  if (opts.loadFailed) return { kind: "load_error" };
  if (isEnglish(opts.language)) return { kind: "not_needed" };
  if (!needsTranslation(opts.language) && !opts.job) return { kind: "not_needed" };

  if (opts.translationRow) {
    const flags = opts.translationRow.flags ?? [];
    if (flags.includes("lang_unknown") && opts.enrichment) {
      // model may have reported English — still show translation if we have one
    }
    return {
      kind: "translated",
      lowTrust: opts.enrichment?.trust === "low",
      mock: opts.enrichment?.origin === "mock",
    };
  }

  if (!opts.job) {
    // Older article, not scheduled (ADR-0028) — show as pending-style load? Use pending message.
    return { kind: "pending" };
  }

  switch (opts.job.state) {
    case "queued":
    case "running":
    case "failed_retryable":
      return { kind: "pending" };
    case "deferred_budget":
      return { kind: "paused" };
    case "skipped_no_content":
      return { kind: "no_content" };
    case "dead":
      return { kind: "failed", reason: opts.job.reason_code ?? "invalid_output" };
    case "succeeded":
      // Race: job succeeded but row missing
      return { kind: "load_error" };
    default:
      return { kind: "pending" };
  }
}
