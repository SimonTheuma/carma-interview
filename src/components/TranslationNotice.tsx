import { strings } from "@/lib/ui/strings";
import type { TranslationPageState } from "@/lib/translate/display";

function failedCopy(reason: string): string {
  if (reason === "too_long") return strings.translationFailedTooLong;
  if (reason === "permanent_failure" || reason === "provider_4xx") {
    return strings.translationFailedRejected;
  }
  if (reason === "attempts" || reason === "max_attempts") {
    return strings.translationFailedAttempts;
  }
  if (reason === "budget_never") return strings.translationFailedBudgetNever;
  return strings.translationFailedChecks;
}

export function TranslationNotice({
  state,
  languageName,
}: {
  state: TranslationPageState;
  languageName?: string;
}) {
  if (state.kind === "not_needed") return null;

  let text = "";
  switch (state.kind) {
    case "pending":
      text = strings.translationPending;
      break;
    case "paused":
      text = strings.translationPaused;
      break;
    case "failed":
      text = failedCopy(state.reason);
      break;
    case "no_content":
      text = strings.translationNoText;
      break;
    case "looks_english":
      text = strings.translationLooksEnglish;
      break;
    case "load_error":
      text = strings.translationLoadError;
      break;
    case "translated":
      return null;
  }

  return (
    <div className="rounded border border-border bg-surface px-3 py-2 text-sm space-y-1" role="status">
      <p>{text}</p>
      {state.kind === "pending" && (
        <p className="text-muted text-xs">{strings.checkBackShortly}</p>
      )}
      {languageName && state.kind !== "no_content" && (
        <p className="text-muted text-xs">Language: {languageName}</p>
      )}
      {state.kind === "failed" && (
        <a href="#trail" className="underline text-xs">
          Details
        </a>
      )}
    </div>
  );
}
