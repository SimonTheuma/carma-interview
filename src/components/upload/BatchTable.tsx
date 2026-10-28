"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { reasonText } from "@/lib/ui/strings";

export type BatchRow = {
  position: number;
  outcome: string;
  reasonCodes: string[];
  articleId: string | null;
  articleVersion: number | null;
  externalId?: string | null;
  source?: string | null;
  sentimentState?: string | null;
  summaryTopicsState?: string | null;
};

type Filter = "all" | "quarantined" | "versions" | "duplicates" | "not_enriched";

type Props = { rows: BatchRow[] };

function outcomeLabel(row: BatchRow): string {
  if (row.reasonCodes.includes("new_version")) return "New version";
  if (row.outcome === "admitted") return "Admitted";
  if (row.outcome === "duplicate") return "Duplicate";
  return "Quarantined";
}

export function BatchTable({ rows }: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === "quarantined") return r.outcome === "quarantined";
      if (filter === "versions") return r.reasonCodes.includes("new_version");
      if (filter === "duplicates") return r.outcome === "duplicate";
      if (filter === "not_enriched") {
        if (r.outcome !== "admitted") return false;
        const s = r.sentimentState;
        const t = r.summaryTopicsState;
        return s !== "succeeded" || t !== "succeeded";
      }
      return true;
    });
  }, [rows, filter]);

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "quarantined", label: "Quarantined" },
    { id: "versions", label: "New versions" },
    { id: "duplicates", label: "Duplicates" },
    { id: "not_enriched", label: "Not enriched" },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Filter report">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setFilter(c.id)}
            className={`px-2 py-0.5 border border-border ${
              filter === c.id ? "bg-foreground text-surface" : "bg-surface"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-start">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="py-1 pe-2 font-medium text-start">#</th>
              <th className="py-1 pe-2 font-medium text-start">Outcome</th>
              <th className="py-1 pe-2 font-medium text-start">Article</th>
              <th className="py-1 pe-2 font-medium text-start">Reasons</th>
              <th className="py-1 pe-2 font-medium text-start">Enrichment</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr
                key={r.position}
                className={`border-b border-border/60 ${
                  r.outcome === "quarantined" ? "bg-amber-50/40" : ""
                }`}
              >
                <td className="py-1 pe-2 font-mono text-xs">{r.position}</td>
                <td className="py-1 pe-2">
                  <span title={r.outcome}>{outcomeLabel(r)}</span>
                </td>
                <td className="py-1 pe-2 font-mono text-xs" dir="ltr">
                  {r.articleId ? (
                    <Link href={`/articles/${r.articleId}`} className="underline">
                      {r.source ?? ""}:{r.externalId ?? r.articleId}
                      {r.articleVersion != null ? ` v${r.articleVersion}` : ""}
                    </Link>
                  ) : (
                    <Link href="/status" className="underline text-muted">
                      quarantine
                    </Link>
                  )}
                </td>
                <td className="py-1 pe-2">
                  <ul className="list-none space-y-0.5">
                    {r.reasonCodes.map((c) => (
                      <li key={c} title={c}>
                        {reasonText(c)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="py-1 pe-2 text-xs text-muted">
                  {r.outcome === "admitted" ? (
                    <>
                      sentiment: {r.sentimentState ?? "—"}
                      <br />
                      topics: {r.summaryTopicsState ?? "—"}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
