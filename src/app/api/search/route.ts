import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";
import { counter, histogram } from "@/lib/metrics";
import { runSearch } from "@/lib/search/run";

export const dynamic = "force-dynamic";

const searchDuration = histogram(
  "mss_search_duration_seconds",
  "List-search duration by broadest term kind",
  [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10],
);
const searchTimeouts = counter("mss_search_timeouts_total", "Search statement timeouts");
const searchMatches = counter("mss_search_matches_total", "Search match side counts");

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sp = {
    q: url.searchParams.get("q") ?? "",
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    source: url.searchParams.getAll("source"),
    lang: url.searchParams.getAll("lang"),
    sentiment: url.searchParams.getAll("sentiment"),
    topic: url.searchParams.getAll("topic"),
    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 20,
    cursor: url.searchParams.get("cursor") ?? undefined,
    includeTotal: url.searchParams.get("include_total") === "1",
  };

  const config = getConfig();
  const pool = getWebPool(config.db);
  const result = await runSearch(pool, sp);
  const headers = new Headers({ "Content-Type": "application/json" });
  if ("timing" in result && result.timing !== undefined) {
    headers.set("Server-Timing", `db;dur=${result.timing.toFixed(1)}`);
  }
  if (result.status === 503) {
    const err = (result.body as { error?: { code?: string } }).error;
    if (err?.code === "timeout") searchTimeouts.inc();
  } else if (result.status === 200 && "timing" in result && result.timing !== undefined) {
    const body = result.body as {
      search_kind?: string;
      articles?: Array<{ matched_in?: string[] }>;
    };
    const kind = body.search_kind && body.search_kind !== "none" ? body.search_kind : "exact";
    searchDuration.observe({ kind }, result.timing / 1000);
    for (const a of body.articles ?? []) {
      for (const s of a.matched_in ?? []) {
        searchMatches.inc({ kind: s });
      }
    }
  }
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}
