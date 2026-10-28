"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { strings } from "@/lib/ui/strings";

type Facets = {
  sources: Array<{ value: string; n: number }>;
  languages: Array<{ value: string; n: number }>;
  sentiments: Array<{ value: string; n: number }>;
  topics: Array<{ value: string; n: number }>;
};

export function FilterBar() {
  const sp = useSearchParams();
  const router = useRouter();
  const [facets, setFacets] = useState<Facets | null>(null);

  const urlFrom = sp.get("from") ?? "";
  const urlTo = sp.get("to") ?? "";
  const [draft, setDraft] = useState({
    from: urlFrom,
    to: urlTo,
    syncedFrom: urlFrom,
    syncedTo: urlTo,
  });
  // Reset local draft when the URL changes (e.g. chip clear) — adjust during render.
  if (draft.syncedFrom !== urlFrom || draft.syncedTo !== urlTo) {
    setDraft({ from: urlFrom, to: urlTo, syncedFrom: urlFrom, syncedTo: urlTo });
  }
  const from = draft.from;
  const to = draft.to;

  useEffect(() => {
    void fetch("/api/facets")
      .then((r) => r.json())
      .then(setFacets)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams(sp.toString());
      if (from) params.set("from", from);
      else params.delete("from");
      if (to) params.set("to", to);
      else params.delete("to");
      const next = params.toString();
      if (next !== sp.toString()) router.replace(`?${next}`);
    }, 250);
    return () => clearTimeout(t);
  }, [from, to, router, sp]);

  function setMulti(key: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    params.set(key, value);
    router.replace(`?${params.toString()}`);
  }

  function clearAll() {
    const params = new URLSearchParams();
    const q = sp.get("q");
    if (q) params.set("q", q);
    router.replace(`?${params.toString()}`);
  }

  const chips: Array<{ key: string; label: string }> = [];
  if (sp.get("from") || sp.get("to")) {
    chips.push({
      key: "date",
      label: `Date: ${sp.get("from") ?? "…"} to ${sp.get("to") ?? "…"}`,
    });
  }
  for (const k of ["source", "lang", "sentiment", "topic"] as const) {
    for (const v of sp.getAll(k)) chips.push({ key: `${k}:${v}`, label: `${k}: ${v}` });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="text-xs text-muted">
          From
          <input
            type="date"
            className="block border border-border rounded px-2 py-1 bg-surface"
            value={from}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
        </label>
        <label className="text-xs text-muted">
          To
          <input
            type="date"
            className="block border border-border rounded px-2 py-1 bg-surface"
            value={to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          />
        </label>
        <label className="text-xs text-muted">
          Source
          <select
            className="block border border-border rounded px-2 py-1 bg-surface min-w-[8rem]"
            value={sp.get("source") ?? ""}
            onChange={(e) => setMulti("source", e.target.value)}
          >
            <option value="">Any</option>
            {facets?.sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value} ({s.n})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Language
          <select
            className="block border border-border rounded px-2 py-1 bg-surface"
            value={sp.get("lang") ?? ""}
            onChange={(e) => setMulti("lang", e.target.value)}
          >
            <option value="">Any</option>
            {facets?.languages.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value} ({s.n})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Sentiment
          <select
            className="block border border-border rounded px-2 py-1 bg-surface"
            value={sp.get("sentiment") ?? ""}
            onChange={(e) => setMulti("sentiment", e.target.value)}
          >
            <option value="">Any</option>
            <option value="not_enriched">Not yet enriched</option>
            {facets?.sentiments.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value} ({s.n})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Topic
          <select
            className="block border border-border rounded px-2 py-1 bg-surface"
            value={sp.get("topic") ?? ""}
            onChange={(e) => setMulti("topic", e.target.value)}
          >
            <option value="">Any</option>
            <option value="not_enriched">Not yet enriched</option>
            {facets?.topics.map((s) => (
              <option key={s.value} value={s.value}>
                {s.value} ({s.n})
              </option>
            ))}
          </select>
        </label>
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              className="text-xs border border-border rounded-full px-2 py-0.5"
              aria-label={`Remove filter: ${c.label}`}
              onClick={() => {
                if (c.key === "date") {
                  const p = new URLSearchParams(sp.toString());
                  p.delete("from");
                  p.delete("to");
                  router.replace(`?${p.toString()}`);
                } else {
                  const [k] = c.key.split(":");
                  const p = new URLSearchParams(sp.toString());
                  p.delete(k!);
                  router.replace(`?${p.toString()}`);
                }
              }}
            >
              {c.label} ×
            </button>
          ))}
          <button type="button" className="text-xs underline" onClick={clearAll}>
            {strings.clearAll}
          </button>
        </div>
      )}
    </div>
  );
}
