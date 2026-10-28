import { strings } from "@/lib/ui/strings";

export type MatchSide = "original" | "translation" | "summary";

export function MatchedInTag({
  sides,
  mock,
}: {
  sides: MatchSide[];
  mock?: boolean;
}) {
  const set = new Set(sides);
  const hasT = set.has("translation");
  const hasS = set.has("summary");
  const hasO = set.has("original");

  // Original alone → no marker (UX 0004 §5.5)
  if (!hasT && !hasS) return null;

  let label: string;
  let title: string = strings.matchedInTooltip;

  if (hasT && hasS) {
    label = strings.matchedInTranslationAndSummary;
    title = strings.matchedInSummaryTooltip;
  } else if (hasS && hasO) {
    label = strings.matchedInOriginalAndSummary;
    title = strings.matchedInSummaryTooltip;
  } else if (hasS) {
    label = strings.matchedInSummary;
    title = strings.matchedInSummaryTooltip;
  } else if (hasT && hasO) {
    label = strings.matchedInBoth;
  } else if (mock) {
    label = strings.matchedInTranslationMock;
  } else {
    label = strings.matchedInTranslation;
  }

  return (
    <span
      className="inline-flex items-center gap-1 text-xs border border-border rounded px-1.5 py-0.5 text-muted"
      title={title}
    >
      <span aria-hidden="true">ℹ</span>
      {label}
    </span>
  );
}
