import { strings } from "@/lib/ui/strings";

export type UntranslatedCounts = {
  queued: number;
  paused: number;
  failed: number;
  older_not_scheduled: number;
  selection: number;
};

export function UntranslatedNote({ counts }: { counts: UntranslatedCounts }) {
  const actionable = counts.queued + counts.paused + counts.failed;
  const n = actionable + counts.older_not_scheduled;
  if (n <= 0) return null;

  const warn =
    counts.selection > 0 && actionable / counts.selection > 0.05;

  return (
    <div
      className={`text-sm rounded px-3 py-2 border ${
        warn ? "border-amber-600 bg-amber-50 text-amber-950" : "border-border text-muted"
      }`}
      role="status"
    >
      <p>{strings.untranslatedNote(n)}</p>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer">Breakdown</summary>
        <ul className="mt-1 list-disc pl-4 space-y-0.5">
          <li>{counts.queued} waiting</li>
          <li>{counts.paused} paused</li>
          <li>{counts.failed} failed</li>
          <li className="text-muted">
            {counts.older_not_scheduled} older articles, not scheduled
          </li>
        </ul>
      </details>
    </div>
  );
}
