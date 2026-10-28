"use client";

import { strings } from "@/lib/ui/strings";

type Props = {
  enriched: number;
  waiting: number;
  deferred: number;
  failed: number;
  admitted: number;
  lastUpdated: string | null;
};

export function EnrichmentProgress({
  enriched,
  waiting,
  deferred,
  failed,
  admitted,
  lastUpdated,
}: Props) {
  const pct = admitted > 0 ? Math.round((enriched / admitted) * 100) : 0;
  return (
    <div className="space-y-2 text-sm">
      <p>
        Enriched {enriched} of {admitted}. Waiting {waiting}. Deferred for budget {deferred}.
        Failed {failed}.
      </p>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Enrichment ${pct}%`}
        className="h-2 bg-border overflow-hidden"
      >
        <div className="h-full bg-foreground transition-all" style={{ width: `${pct}%` }} />
      </div>
      {deferred > 0 && <p className="text-muted text-xs">{strings.budgetDeferral}</p>}
      {lastUpdated && (
        <p className="text-xs text-muted">Last updated {lastUpdated}</p>
      )}
    </div>
  );
}
