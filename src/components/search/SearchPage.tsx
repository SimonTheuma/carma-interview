"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { parseQuery, echoAst, classifyLeaf } from "@/lib/search";
import type { AstNode } from "@/lib/search/parse";
import { strings } from "@/lib/ui/strings";
import { ArticleCard } from "@/components/ArticleCard";
import { FilterBar } from "@/components/FilterBar";
import { CoverageLine } from "@/components/CoverageLine";
import { UntranslatedNote } from "@/components/UntranslatedNote";

type SearchResponse = {
  articles: Array<Record<string, unknown>>;
  next_cursor: string | null;
  parsed: string | null;
  echo_notes?: string[];
  coverage: {
    articles_matching_base_filters: number;
    articles_in_scope: number;
    corpus_articles: number;
    enriched_sentiment: number;
    enriched_topics: number;
    excluded_by_filter_not_enriched: number;
    watermark: { published_at: string | null; ingested_at: string | null };
  } | null;
  translation_coverage?: {
    queued: number;
    paused: number;
    failed: number;
    older_not_scheduled: number;
    selection: number;
    foreign: number;
    translated: number;
  };
  total?: number;
  error?: { message: string; position?: number };
};

const EXAMPLES = [
  { label: "oil prices…", q: `"oil prices" AND (geopolitical OR "supply chain")` },
  { label: "renewable AND NOT…", q: `renewable AND NOT (nuclear OR coal)` },
  { label: "AI AND…", q: `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` },
];

function astHasAndNot(ast: AstNode | null): boolean {
  if (!ast) return false;
  if (ast.type === "and_not") return true;
  if (ast.type === "and" || ast.type === "or") {
    return astHasAndNot(ast.left) || astHasAndNot(ast.right);
  }
  return false;
}

export default function SearchPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const urlQ = sp.get("q") ?? "";
  const [qState, setQState] = useState({ value: urlQ, synced: urlQ });
  if (qState.synced !== urlQ) {
    setQState({ value: urlQ, synced: urlQ });
  }
  const q = qState.value;
  const setQ = (value: string) => setQState((s) => ({ ...s, value }));
  const [parseError, setParseError] = useState<{ message: string; position: number } | null>(null);
  const [echo, setEcho] = useState<string | null>(null);
  const [hasAndNot, setHasAndNot] = useState(false);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncing, setDebouncing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      const r = parseQuery(q);
      if (!r.ok) {
        setParseError({ message: r.error.message, position: r.error.position });
        setHasAndNot(false);
      } else {
        setParseError(null);
        setEcho(echoAst(r.ast) || null);
        setHasAndNot(astHasAndNot(r.ast));
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const filterKey = useMemo(
    () =>
      [
        sp.get("from"),
        sp.get("to"),
        sp.getAll("source").join(","),
        sp.getAll("lang").join(","),
        sp.getAll("sentiment").join(","),
        sp.getAll("topic").join(","),
      ].join("|"),
    [sp],
  );

  const runSearch = useCallback(
    async (query: string, cursor?: string, append = false) => {
      const my = ++seq.current;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);
      const progressTimer = setTimeout(() => setShowProgress(true), 150);
      try {
        const url = new URL("/api/search", window.location.origin);
        url.searchParams.set("q", query);
        url.searchParams.set("include_total", "1");
        for (const k of ["from", "to"] as const) {
          const v = sp.get(k);
          if (v) url.searchParams.set(k, v);
        }
        for (const k of ["source", "lang", "sentiment", "topic"] as const) {
          for (const v of sp.getAll(k)) url.searchParams.append(k, v);
        }
        if (cursor) url.searchParams.set("cursor", cursor);
        const res = await fetch(url, { signal: ac.signal });
        const json = (await res.json()) as SearchResponse;
        if (my !== seq.current) return;
        if (!res.ok) {
          setError(json.error?.message ?? strings.serviceError);
          return;
        }
        setData((d) =>
          append && d
            ? {
                ...json,
                articles: [...d.articles, ...json.articles],
              }
            : json,
        );
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        if (my !== seq.current) return;
        setError(strings.serviceError);
      } finally {
        clearTimeout(progressTimer);
        if (my === seq.current) {
          setLoading(false);
          setShowProgress(false);
        }
      }
    },
    [sp],
  );

  useEffect(() => {
    // Defer so setLoading inside runSearch is not synchronous with the effect body.
    const t = setTimeout(() => void runSearch(sp.get("q") ?? ""), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp.get("q"), filterKey]);

  function clearDebounce() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setDebouncing(false);
  }

  function submit(nextQ: string) {
    clearDebounce();
    const r = parseQuery(nextQ);
    if (!r.ok) {
      setParseError({ message: r.error.message, position: r.error.position });
      return;
    }
    const params = new URLSearchParams(sp.toString());
    if (nextQ) params.set("q", nextQ);
    else params.delete("q");
    const next = params.toString();
    const cur = sp.toString();
    if (next === cur) {
      void runSearch(nextQ);
      return;
    }
    router.push(`/?${next}`);
  }

  // Auto-search after 500ms of idle typing (skip invalid queries).
  useEffect(() => {
    if (q === urlQ) {
      clearDebounce();
      return;
    }
    const r = parseQuery(q);
    if (!r.ok) {
      clearDebounce();
      return;
    }
    setDebouncing(true);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setDebouncing(false);
      submit(q);
    }, 500);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, urlQ]);

  const fieldBusy = loading || debouncing;

  const display = data;
  const dimmed = loading && !!data;

  let empty: "no_match" | "not_covered" | null = null;
  if (display && display.articles.length === 0 && !loading) {
    if (display.coverage && display.coverage.articles_matching_base_filters === 0) {
      empty = "not_covered";
    } else {
      empty = "no_match";
    }
  }

  return (
    <div className="space-y-4">
      {showProgress && (
        <div className="h-0.5 bg-accent/40 animate-pulse" role="progressbar" aria-busy="true" />
      )}
      <div>
        <label htmlFor="q" className="sr-only">
          {strings.searchLabel}
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              id="q"
              className="w-full border border-border rounded px-3 py-2 pr-9 bg-surface"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit(q);
              }}
              aria-invalid={!!parseError}
              aria-describedby="parse-echo parse-err"
              aria-busy={fieldBusy}
              dir="auto"
            />
            {fieldBusy && (
              <span
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                aria-hidden
              >
                <svg
                  className="h-4 w-4 animate-spin"
                  viewBox="0 0 16 16"
                  fill="none"
                >
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
          <button
            type="button"
            className="px-4 py-2 bg-accent text-white rounded"
            onClick={() => submit(q)}
            disabled={loading && !parseError}
          >
            {loading ? strings.searching : strings.searchButton}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.q}
              type="button"
              className="text-xs border border-border rounded px-2 py-1 bg-surface"
              onClick={() => {
                setQ(ex.q);
                submit(ex.q);
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{strings.wildcardTip}</p>
        {echo && !parseError && (
          <p id="parse-echo" className="mt-2 text-sm text-muted">
            {strings.interpretedAs} <code className="text-foreground">{echo}</code>
          </p>
        )}
        {echo && !parseError && hasAndNot && (
          <p id="not-rule-note" className="mt-1 text-xs text-muted">
            {strings.notOriginalOnlyNote}
          </p>
        )}
        {parseError && (
          <p id="parse-err" className="mt-2 text-sm text-danger" role="alert">
            {parseError.message}
            {data ? (
              <span className="block text-muted">Showing results for the previous query</span>
            ) : null}
          </p>
        )}
      </div>

      <FilterBar />

      {display?.coverage && <CoverageLine coverage={display.coverage} />}
      {display?.translation_coverage && (
        <UntranslatedNote counts={display.translation_coverage} />
      )}
      {display?.echo_notes
        ?.filter((note) => note !== strings.notOriginalOnlyNote)
        .map((note) => (
          <p key={note} className="text-xs text-muted">
            {note}
          </p>
        ))}

      {display && (
        <div className="flex justify-between items-baseline text-sm">
          <span>
            Showing {display.articles.length}
            {display.total !== undefined ? ` of ${display.total}` : ""}
          </span>
          <a
            href={`/trends?${new URLSearchParams({ ...(sp.get("q") ? { q: sp.get("q")! } : {}), ...Object.fromEntries(sp.entries()) }).toString()}`}
            className="text-accent"
          >
            {strings.viewTrends}
          </a>
        </div>
      )}

      {error && (
        <div role="alert" className="border border-danger/40 bg-surface p-3 rounded">
          <p>{error}</p>
          <button type="button" className="mt-2 underline" onClick={() => runSearch(sp.get("q") ?? "")}>
            {strings.tryAgain}
          </button>
        </div>
      )}

      <ul className={`space-y-3 ${dimmed ? "opacity-50" : ""}`} aria-busy={loading}>
        {display?.articles.map((a) => (
          <li key={String(a.id)}>
            <ArticleCard article={a} />
          </li>
        ))}
      </ul>

      {empty === "no_match" && (
        <div className="py-8 space-y-2">
          <h2 className="font-medium">{strings.emptyNoMatch}</h2>
          {(() => {
            const raw = sp.get("q") ?? "";
            const parsed = parseQuery(raw);
            if (!parsed.ok || !parsed.ast) return null;
            let bareLatin = false;
            let hasWildcard = false;
            const walk = (node: NonNullable<typeof parsed.ast>) => {
              if (node.type === "term") {
                if (node.wildcard) hasWildcard = true;
                else if (
                  !node.phrase &&
                  classifyLeaf(node.value) === "exact"
                ) {
                  bareLatin = true;
                }
                return;
              }
              walk(node.left);
              walk(node.right);
            };
            walk(parsed.ast);
            if (bareLatin && !hasWildcard) {
              return <p className="text-sm text-muted">{strings.emptyTryWildcard}</p>;
            }
            if (raw.includes('"')) {
              return <p className="text-sm text-muted">{strings.emptyTryBroader}</p>;
            }
            return null;
          })()}
          {display?.translation_coverage && (
            <UntranslatedNote counts={display.translation_coverage} />
          )}
        </div>
      )}
      {empty === "not_covered" && (
        <div className="py-8">
          <h2 className="font-medium">
            {strings.emptyNotCovered(
              display?.coverage?.articles_in_scope ?? 0,
              "—",
              display?.coverage?.watermark.published_at?.slice(0, 10) ?? "—",
            )}
          </h2>
        </div>
      )}

      {display?.next_cursor && (
        <button
          type="button"
          className="border border-border px-4 py-2 rounded bg-surface"
          disabled={loading}
          onClick={() => runSearch(sp.get("q") ?? "", display.next_cursor!, true)}
        >
          {strings.showMore}
        </button>
      )}

      {!display && loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 bg-border/40 rounded animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}
