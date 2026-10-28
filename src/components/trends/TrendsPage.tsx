"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { parseQuery, echoAst } from "@/lib/search";
import { strings } from "@/lib/ui/strings";
import { FilterBar } from "@/components/FilterBar";
import Link from "next/link";

type Bucket = { bucket_start: string; series: string | null; n: number };

const MAX_QUERIES = 4;
// Distinct hues for compared queries; the legend and table also name every series.
const COMPARE_COLORS = ["#2c5f4a", "#b45309", "#1d4ed8", "#9d174d"];
const BAR_W = 14;

class AggregateError extends Error {}

// Drop blank and duplicate queries, but always keep one (blank = all articles).
function normalize(list: string[]): string[] {
  const kept = [...new Set(list.filter((s) => s.trim() !== ""))].slice(0, MAX_QUERIES);
  return kept.length ? kept : [""];
}

export default function TrendsPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const bucket = sp.get("bucket") === "month" ? "month" : "week";
  const split = sp.get("split") ?? "none";
  const view = sp.get("view") === "table" ? "table" : "chart";
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [totals, setTotals] = useState<number[]>([0]);
  const [error, setError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [debouncing, setDebouncing] = useState(false);
  const urlQs = normalize(sp.getAll("q"));
  const urlKey = JSON.stringify(urlQs);
  const compare = urlQs.length > 1;
  const [qState, setQState] = useState({ value: urlQs, synced: urlKey });
  if (qState.synced !== urlKey) {
    setQState({ value: urlQs, synced: urlKey });
  }
  const qs = qState.value;
  const setQs = (value: string[]) => setQState((s) => ({ ...s, value }));
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const my = ++seq.current;
    abortRef.current?.abort();
    const qList = JSON.parse(urlKey) as string[];
    // No terms → idle; do not hit /api/aggregate for an empty query.
    if (qList.every((qq) => qq.trim() === "")) {
      setBuckets([]);
      setTotals([0]);
      setError(null);
      setLoading(false);
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setLoading(true);
    const isCompare = qList.length > 1;
    // Splitting and comparing don't combine: in compare mode each query is its own series.
    const effSplit = isCompare ? "none" : split;
    async function fetchOne(qq: string) {
      const url = new URL("/api/aggregate", window.location.origin);
      url.searchParams.set("q", qq);
      url.searchParams.set("bucket", bucket);
      url.searchParams.set("split", effSplit);
      for (const k of ["from", "to"] as const) {
        const v = sp.get(k);
        if (v) url.searchParams.set(k, v);
      }
      for (const k of ["source", "lang", "sentiment", "topic"] as const) {
        for (const v of sp.getAll(k)) url.searchParams.append(k, v);
      }
      const r = await fetch(url, { signal: ac.signal });
      const j = await r.json();
      if (!r.ok) throw new AggregateError(j.error?.message ?? "Aggregate failed");
      return j as { buckets?: Bucket[]; total?: number };
    }
    void Promise.all(qList.map(fetchOne))
      .then((results) => {
        if (my !== seq.current) return;
        setError(null);
        setBuckets(
          isCompare
            ? results.flatMap((j, i) =>
                (j.buckets ?? []).map((b): Bucket => ({ ...b, series: qList[i] ?? "" })),
              )
            : (results[0]?.buckets ?? []),
        );
        setTotals(results.map((j) => j.total ?? 0));
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        if (my !== seq.current) return;
        setError(e instanceof AggregateError ? e.message : "Aggregate failed");
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
  }, [sp, bucket, split, urlKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const b of buckets) {
      const key = String(b.bucket_start);
      if (!map.has(key)) map.set(key, new Map());
      map.get(key)!.set(b.series ?? "total", b.n);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [buckets]);

  const maxN = Math.max(1, ...buckets.map((b) => b.n));
  const slot = compare ? urlQs.length * BAR_W + 14 : 48;
  const seriesNames = compare
    ? urlQs
    : [...new Set(buckets.map((b) => b.series ?? "total").filter((s) => s !== null))];
  const seriesLabel = (s: string) => (compare && s === "" ? "All articles" : s);

  function clearDebounce() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDebouncing(false);
  }

  function firstParseError(list: string[]): string | null {
    for (const qq of list) {
      if (qq.trim() === "") continue;
      const r = parseQuery(qq);
      if (!r.ok) return r.error.message;
    }
    return null;
  }

  function submit(nextQs: string[]) {
    clearDebounce();
    const err = firstParseError(nextQs);
    if (err) {
      setParseError(err);
      return;
    }
    setParseError(null);
    const p = new URLSearchParams(sp.toString());
    p.delete("q");
    const kept = normalize(nextQs);
    if (kept.length > 1 || kept[0] !== "") for (const qq of kept) p.append("q", qq);
    const next = p.toString();
    if (next === sp.toString()) return;
    router.push(`/trends?${next}`);
  }

  useEffect(() => {
    if (JSON.stringify(normalize(qs)) === urlKey) {
      clearDebounce();
      setParseError(null);
      return;
    }
    const err = firstParseError(qs);
    if (err) {
      clearDebounce();
      setParseError(err);
      return;
    }
    setParseError(null);
    setDebouncing(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setDebouncing(false);
      submit(qs);
    }, 500);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qs, urlKey]);

  const fieldBusy = loading || debouncing;

  function setParam(key: string, value: string) {
    const p = new URLSearchParams(sp.toString());
    p.set(key, value);
    router.replace(`/trends?${p.toString()}`);
  }

  function barHref(start: string, series: string | null) {
    const startDate = new Date(start);
    const end = new Date(startDate);
    if (bucket === "week") end.setUTCDate(end.getUTCDate() + 7);
    else end.setUTCMonth(end.getUTCMonth() + 1);
    const p = new URLSearchParams(sp.toString());
    p.set("from", startDate.toISOString().slice(0, 10));
    p.set("to", end.toISOString().slice(0, 10));
    if (compare) {
      // Each series is a query: drill into that query (or all of them for the bucket link).
      p.delete("q");
      if (series !== null) {
        if (series) p.set("q", series);
      } else {
        for (const qq of urlQs) if (qq) p.append("q", qq);
      }
    } else if (series && series !== "total" && series !== "not_enriched") {
      if (split === "sentiment") p.set("sentiment", series);
      if (split === "topic") p.set("topic", series);
      if (split === "language") p.set("lang", series);
    }
    if (!compare && series === "not_enriched") {
      if (split === "sentiment") p.set("sentiment", "not_enriched");
      if (split === "topic") p.set("topic", "not_enriched");
    }
    p.delete("bucket");
    p.delete("split");
    p.delete("view");
    return `/?${p.toString()}`;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Trends</h1>
      <div className="space-y-2">
        {qs.map((value, i) => (
          <div key={i} className="flex items-center gap-2">
            {compare && (
              <span
                className="h-3 w-3 shrink-0 rounded-sm"
                style={{ background: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
                aria-hidden
              />
            )}
            <div className="relative flex-1">
              <input
                className="w-full border border-border rounded px-3 py-2 pr-9 bg-surface"
                aria-label={qs.length > 1 ? `Query ${i + 1}` : "Query"}
                value={value}
                onChange={(e) => setQs(qs.map((v, j) => (j === i ? e.target.value : v)))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit(qs);
                }}
                aria-invalid={!!parseError}
                aria-busy={fieldBusy}
                dir="auto"
              />
              {fieldBusy && i === 0 && (
                <span
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                  aria-hidden
                >
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle
                      cx="8"
                      cy="8"
                      r="6"
                      stroke="currentColor"
                      strokeOpacity="0.25"
                      strokeWidth="2"
                    />
                    <path
                      d="M14 8a6 6 0 0 0-6-6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
              )}
            </div>
            {qs.length > 1 && (
              <button
                type="button"
                className="text-sm px-2 py-1 border border-border rounded bg-surface"
                aria-label={`Remove query ${i + 1}`}
                onClick={() => submit(qs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {qs.length < MAX_QUERIES && (
          <button
            type="button"
            className="text-sm px-2 py-1 border border-border rounded bg-surface"
            onClick={() => setQs([...qs, ""])}
          >
            + Compare another query
          </button>
        )}
        <p className="mt-1 text-xs text-muted">{strings.wildcardTip}</p>
        {!parseError &&
          qs.map((qq, i) => {
            if (!qq.trim()) return null;
            const r = parseQuery(qq);
            if (!r.ok) return null;
            const echo = echoAst(r.ast);
            if (!echo) return null;
            return (
              <p key={`echo-${i}`} className="text-sm text-muted">
                {qs.length > 1 ? `Query ${i + 1}: ` : `${strings.interpretedAs} `}
                <code className="text-foreground">{echo}</code>
              </p>
            );
          })}
      </div>
      {parseError && (
        <p className="text-sm text-danger" role="alert">
          {parseError}
        </p>
      )}
      <FilterBar />
      <div className="flex flex-wrap gap-3 text-sm">
        <label>
          Bucket{" "}
          <select
            value={bucket}
            onChange={(e) => setParam("bucket", e.target.value)}
            className="border border-border rounded px-2 py-1 bg-surface"
          >
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        <label className={compare ? "text-muted" : undefined}>
          Split by{" "}
          <select
            value={compare ? "none" : split}
            disabled={compare}
            aria-disabled={compare}
            title={
              compare
                ? "Splitting is unavailable while comparing queries"
                : undefined
            }
            onChange={(e) => setParam("split", e.target.value)}
            className={
              compare
                ? "border border-border rounded px-2 py-1 bg-surface opacity-50 cursor-not-allowed"
                : "border border-border rounded px-2 py-1 bg-surface"
            }
          >
            <option value="none">None</option>
            {!compare && (
              <>
                <option value="sentiment">Sentiment</option>
                <option value="language">Language</option>
                <option value="topic">Topic</option>
              </>
            )}
          </select>
        </label>
        <label>
          View{" "}
          <select
            value={view}
            onChange={(e) => setParam("view", e.target.value)}
            className="border border-border rounded px-2 py-1 bg-surface"
          >
            <option value="chart">Chart</option>
            <option value="table">Table</option>
          </select>
        </label>
      </div>
      <p className="text-sm text-muted">
        {compare
          ? urlQs.map((qq, i) => `${seriesLabel(qq)}: ${totals[i] ?? 0}`).join(" · ")
          : `${totals[0] ?? 0} articles`}{" "}
        · {bucket}s start {bucket === "week" ? "Monday" : "day 1"}, UTC
      </p>
      {compare && (
        <p className="text-sm text-muted">
          Comparing {urlQs.length} queries, so splitting is off. An article matching more than one
          query is counted under each.
        </p>
      )}
      {!compare && split === "topic" && (
        <p className="text-sm text-muted">
          An article counts under each of its topics, so the bars can add up to more than the total.
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}

      {view === "chart" && compare && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {urlQs.map((qq, i) => (
            <span key={qq} className="inline-flex items-center gap-1">
              <span
                className="h-3 w-3 rounded-sm"
                style={{ background: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
                aria-hidden
              />
              {seriesLabel(qq)}
            </span>
          ))}
        </div>
      )}

      {view === "chart" && (
        <svg
          role="img"
          aria-label={`Bar chart of article counts by ${bucket}${compare ? ", one bar per query" : ""}`}
          viewBox={`0 0 ${Math.max(400, 40 + grouped.length * slot)} 220`}
          className="w-full max-w-full border border-border bg-surface"
        >
          {grouped.map(([start, seriesMap], i) => {
            const x = 40 + i * slot;
            let y = 200;
            const entries = compare
              ? urlQs.map((qq) => [qq, seriesMap.get(qq) ?? 0] as const)
              : [...seriesMap.entries()];
            return (
              <g key={start}>
                {entries.map(([series, n], j) => {
                  const h = (n / maxN) * 160;
                  if (!compare) y -= h;
                  const hatch = !compare && series === "not_enriched";
                  return (
                    <a
                      key={series}
                      href={barHref(start, series)}
                      aria-label={`${seriesLabel(series)}: ${n}`}
                    >
                      <rect
                        x={compare ? x + j * BAR_W : x}
                        y={compare ? 200 - h : y}
                        width={compare ? BAR_W - 2 : 32}
                        height={h}
                        fill={
                          hatch
                            ? "url(#hatch)"
                            : compare
                              ? COMPARE_COLORS[j % COMPARE_COLORS.length]
                              : "#2c5f4a"
                        }
                        opacity={0.85}
                      />
                    </a>
                  );
                })}
                <text
                  x={x + (compare ? (urlQs.length * BAR_W) / 2 : 16)}
                  y={215}
                  textAnchor="middle"
                  fontSize="9"
                  fill="#6b6a68"
                >
                  {start.slice(5, 10)}
                </text>
              </g>
            );
          })}
          <defs>
            <pattern id="hatch" patternUnits="userSpaceOnUse" width="6" height="6">
              <path d="M0,6 l6,-6 M-1,1 l2,-2 M5,7 l2,-2" stroke="#6b6a68" strokeWidth="1" />
            </pattern>
          </defs>
        </svg>
      )}

      <div className={view === "table" ? "" : "sr-only"}>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr>
              <th className="text-left border-b border-border p-2">Bucket</th>
              {seriesNames.map((s) => (
                <th key={s} className="text-right border-b border-border p-2">
                  {seriesLabel(s)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([start, seriesMap]) => (
              <tr key={start}>
                <td className="p-2 border-b border-border">
                  <Link href={barHref(start, null)}>{start.slice(0, 10)}</Link>
                </td>
                {seriesNames.map((s) => (
                  <td key={s} className="p-2 border-b border-border text-right">
                    <Link href={barHref(start, s)}>{seriesMap.get(s) ?? 0}</Link>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
