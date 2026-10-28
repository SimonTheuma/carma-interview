import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";
import { parseQuery, compileAst, echoAst, buildFilterClauses, parseDateParam } from "@/lib/search";
import type { SearchFilters } from "@/lib/search/filters";

export const dynamic = "force-dynamic";

function isStatementTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("statement timeout") || msg.includes("canceling statement");
}

/** Shift `$n` placeholders by `by` (used so series SQL can reserve $1/$2 for bounds). */
export function shiftPlaceholders(sql: string, by: number): string {
  return sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + by}`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const bucket = url.searchParams.get("bucket") === "month" ? "month" : "week";
  const split = url.searchParams.get("split") ?? "none";
  const from = parseDateParam(url.searchParams.get("from"), "from");
  const to = parseDateParam(url.searchParams.get("to"), "to");

  const filters: SearchFilters = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(url.searchParams.getAll("source").length
      ? { sources: url.searchParams.getAll("source") }
      : {}),
    ...(url.searchParams.getAll("lang").length
      ? { languages: url.searchParams.getAll("lang") }
      : {}),
    ...(url.searchParams.getAll("sentiment").length
      ? { sentiments: url.searchParams.getAll("sentiment") }
      : {}),
    ...(url.searchParams.getAll("topic").length
      ? { topics: url.searchParams.getAll("topic") }
      : {}),
  };

  const parsed = parseQuery(q);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  // WHERE params start at $1 for filter-only queries (bounds / total).
  // Series SQL reserves $1/$2 for generate_series bounds, so WHERE is shifted +2.
  const compiled = compileAst(parsed.ast, 1);
  const fb = buildFilterClauses(filters, compiled.params.length + 1);
  const whereParts: string[] = [];
  if (compiled.sql) whereParts.push(`(${compiled.sql})`);
  whereParts.push(...fb.clauses);
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "WHERE true";
  const whereParams: unknown[] = [...compiled.params, ...fb.params];
  const whereForSeries = shiftPlaceholders(where, 2);
  const seriesParams: unknown[] = [
    from?.toISOString() ?? null,
    to?.toISOString() ?? null,
    ...whereParams,
  ];

  const trunc = bucket === "month" ? "month" : "week";
  const config = getConfig();
  const pool = getWebPool(config.db);

  try {
    // Cap buckets — only bind params that WHERE actually references (FP: empty q → WHERE true).
    const bounds = await pool.query<{ lo: string | null; hi: string | null }>(
      `WITH f AS (SELECT a.published_at FROM articles a ${where})
       SELECT min(published_at)::text AS lo, max(published_at)::text AS hi FROM f`,
      whereParams,
    );
    const lo = from ?? (bounds.rows[0]?.lo ? new Date(bounds.rows[0].lo) : null);
    const hi = to ?? (bounds.rows[0]?.hi ? new Date(new Date(bounds.rows[0].hi).getTime() + 1) : null);
    if (lo && hi) {
      const ms = hi.getTime() - lo.getTime();
      const bucketMs = bucket === "month" ? 30 * 86400_000 : 7 * 86400_000;
      if (ms / bucketMs > 520) {
        return Response.json(
          { error: { code: "range_too_wide", message: `That range has too many ${bucket}s. Choose a shorter range or switch to months.` } },
          { status: 400 },
        );
      }
    }

    let seriesSql: string;
    let multiLabel = false;

    if (split === "sentiment") {
      seriesSql = `
        WITH f AS (
          SELECT a.id, a.published_at,
                 COALESCE(d.value, 'not_enriched') AS series
            FROM articles a
            LEFT JOIN derived_values d
              ON d.article_id = a.id AND d.field = 'sentiment' AND d.is_current
            ${whereForSeries}
        ),
        bounds AS (
          SELECT COALESCE($1::timestamptz, min(published_at)) AS lo,
                 COALESCE($2::timestamptz, max(published_at) + interval '1 microsecond') AS hi
            FROM f
        ),
        series AS (
          SELECT g AS bucket_start
            FROM bounds,
                 generate_series(
                   date_trunc('${trunc}', lo AT TIME ZONE 'UTC'),
                   date_trunc('${trunc}', (hi - interval '1 microsecond') AT TIME ZONE 'UTC'),
                   interval '1 ${trunc}'
                 ) g
        )
        SELECT s.bucket_start, f.series, count(f.id)::int AS n
          FROM series s
          LEFT JOIN f ON date_trunc('${trunc}', f.published_at AT TIME ZONE 'UTC') = s.bucket_start
         GROUP BY s.bucket_start, f.series
         ORDER BY s.bucket_start, f.series
      `;
    } else if (split === "topic") {
      multiLabel = true;
      seriesSql = `
        WITH f AS (
          SELECT a.id, a.published_at,
                 COALESCE(d.value, 'not_enriched') AS series
            FROM articles a
            LEFT JOIN derived_values d
              ON d.article_id = a.id AND d.field = 'topic' AND d.is_current
            ${whereForSeries}
        ),
        bounds AS (
          SELECT COALESCE($1::timestamptz, min(published_at)) AS lo,
                 COALESCE($2::timestamptz, max(published_at) + interval '1 microsecond') AS hi
            FROM f
        ),
        series AS (
          SELECT g AS bucket_start
            FROM bounds,
                 generate_series(
                   date_trunc('${trunc}', lo AT TIME ZONE 'UTC'),
                   date_trunc('${trunc}', (hi - interval '1 microsecond') AT TIME ZONE 'UTC'),
                   interval '1 ${trunc}'
                 ) g
        )
        SELECT s.bucket_start, f.series, count(DISTINCT f.id)::int AS n
          FROM series s
          LEFT JOIN f ON date_trunc('${trunc}', f.published_at AT TIME ZONE 'UTC') = s.bucket_start
         GROUP BY s.bucket_start, f.series
         ORDER BY s.bucket_start, f.series
      `;
    } else if (split === "language") {
      seriesSql = `
        WITH f AS (
          SELECT a.id, a.published_at, a.language AS series
            FROM articles a
            ${whereForSeries}
        ),
        bounds AS (
          SELECT COALESCE($1::timestamptz, min(published_at)) AS lo,
                 COALESCE($2::timestamptz, max(published_at) + interval '1 microsecond') AS hi
            FROM f
        ),
        series AS (
          SELECT g AS bucket_start
            FROM bounds,
                 generate_series(
                   date_trunc('${trunc}', lo AT TIME ZONE 'UTC'),
                   date_trunc('${trunc}', (hi - interval '1 microsecond') AT TIME ZONE 'UTC'),
                   interval '1 ${trunc}'
                 ) g
        )
        SELECT s.bucket_start, f.series, count(f.id)::int AS n
          FROM series s
          LEFT JOIN f ON date_trunc('${trunc}', f.published_at AT TIME ZONE 'UTC') = s.bucket_start
         GROUP BY s.bucket_start, f.series
         ORDER BY s.bucket_start, f.series
      `;
    } else {
      seriesSql = `
        WITH f AS (
          SELECT a.id, a.published_at FROM articles a ${whereForSeries}
        ),
        bounds AS (
          SELECT COALESCE($1::timestamptz, min(published_at)) AS lo,
                 COALESCE($2::timestamptz, max(published_at) + interval '1 microsecond') AS hi
            FROM f
        ),
        series AS (
          SELECT g AS bucket_start
            FROM bounds,
                 generate_series(
                   date_trunc('${trunc}', lo AT TIME ZONE 'UTC'),
                   date_trunc('${trunc}', (hi - interval '1 microsecond') AT TIME ZONE 'UTC'),
                   interval '1 ${trunc}'
                 ) g
        )
        SELECT s.bucket_start, NULL::text AS series, count(f.id)::int AS n
          FROM series s
          LEFT JOIN f ON date_trunc('${trunc}', f.published_at AT TIME ZONE 'UTC') = s.bucket_start
         GROUP BY s.bucket_start
         ORDER BY s.bucket_start
      `;
    }

    const started = performance.now();
    const res = await pool.query(seriesSql, seriesParams);
    const timing = performance.now() - started;

    const buckets = res.rows.map((r) => ({
      bucket_start: r.bucket_start,
      series: r.series,
      n: r.n,
    }));

    const total = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM articles a ${where}`,
      whereParams,
    );

    return new Response(
      JSON.stringify({
        bucket,
        split,
        multi_label: multiLabel,
        buckets,
        total: Number(total.rows[0]?.n ?? 0),
        parsed: echoAst(parsed.ast),
        resolved_range: {
          from: from?.toISOString() ?? null,
          to: to?.toISOString() ?? null,
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Server-Timing": `db;dur=${timing.toFixed(1)}`,
        },
      },
    );
  } catch (err) {
    if (isStatementTimeout(err)) {
      return Response.json(
        {
          error: {
            code: "timeout",
            message:
              "That aggregate took too long. Try narrowing the date range or removing a wildcard.",
          },
        },
        { status: 503 },
      );
    }
    throw err;
  }
}
