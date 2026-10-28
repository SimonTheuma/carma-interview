/**
 * Language helpers for deciding whether an article needs translation.
 * Single source of truth — the boolean is passed into SQL (ingest_new_version).
 */

/** True when the primary language tag is English (`en` / `eng`, any case, `-` or `_`). */
export function isEnglish(language: string | null | undefined): boolean {
  if (language == null) return false;
  const raw = language.trim();
  if (!raw || raw.toLowerCase() === "n/a" || raw.toLowerCase() === "null") return false;
  const primary = raw.split(/[-_]/)[0]?.toLowerCase() ?? "";
  return primary === "en" || primary === "eng";
}

/** Unknown, empty, or non-English languages need translation. */
export function needsTranslation(language: string | null | undefined): boolean {
  return !isEnglish(language);
}
