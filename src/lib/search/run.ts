import type pg from "pg";
import { getConfig } from "../config";
import { parseQuery, compileAst, echoAst, buildFilterClauses, parseDateParam, baseFiltersOnly } from "./index";
import { classifyLeaf } from "./leaf";
import { strings } from "../ui/strings";
import type { SearchFilters } from "./filters";
import { decodeCursor, encodeCursor, hashFilters } from "./cursor";

export type SearchCoverage = {
  articles_matching_base_filters: number;
  articles_in_scope: number;
  corpus_articles: number;
  enriched_sentiment: number;
  enriched_topics: number;
  excluded_by_filter_not_enriched: number;
  watermark: { published_at: string | null; ingested_at: string | null };
};

export type TranslationCoverage = {
  foreign: number;
  translated: number;
  queued: number;
  paused: number;
  failed: number;
  older_not_scheduled: number;
  selection: number;
};

const COVERAGE_FLAG_KEYS = [
  "coverage_corpus_articles",
  "coverage_enriched_sentiment",
  "coverage_enriched_topics",
  "coverage_watermark_published_at",
  "coverage_watermark_ingested_at",
  "trgm_index",
] as const;

export type SearchParams = {
  q?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  source?: string[] | undefined;
  lang?: string[] | undefined;
  sentiment?: string[] | undefined;
  topic?: string[] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  includeTotal?: boolean | undefined;
};

function multi(v: string | string[] | null | undefined): string[] | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : v.split(",");
  const cleaned = arr.map((s) => s.trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

export function filtersFromParams(sp: SearchParams): SearchFilters {
  const filters: SearchFilters = {};
  const from = parseDateParam(sp.from, "from");
  const to = parseDateParam(sp.to, "to");
  if (from) filters.from = from;
  if (to) filters.to = to;
  const sources = multi(sp.source);
  if (sources) filters.sources = sources;
  const languages = multi(sp.lang);
  if (languages) filters.languages = languages;
  const sentiments = multi(sp.sentiment);
  if (sentiments) filters.sentiments = sentiments;
  const topics = multi(sp.topic);
  if (topics) filters.topics = topics;
  return filters;
}

export async function runSearch(db: pg.Pool | pg.PoolClient, sp: SearchParams) {
  const config = getConfig();
  const q = sp.q ?? "";
  const parsed = parseQuery(q);
  if (!parsed.ok) {
    return {
      status: 400 as const,
      body: {
        error: parsed.error,
        parsed: null,
      },
    };
  }

  const filters = filtersFromParams(sp);
  const filterHash = hashFilters(
    JSON.stringify({
      q,
      from: sp.from ?? null,
      to: sp.to ?? null,
      source: sp.source ?? null,
      lang: sp.lang ?? null,
      sentiment: sp.sentiment ?? null,
      topic: sp.topic ?? null,
    }),
  );

  let limit = sp.limit ?? 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  const compiled = compileAst(parsed.ast, 1);
  const afterText = buildFilterClauses(filters, compiled.params.length + 1);
  const whereParts: string[] = [];
  if (compiled.sql) whereParts.push(`(${compiled.sql})`);
  whereParts.push(...afterText.clauses);

  let cursorClause = "";
  const params: unknown[] = [...compiled.params, ...afterText.params];
  let nextIdx = afterText.nextIndex;

  if (sp.cursor) {
    const cur = decodeCursor(sp.cursor, config.cursorSecret);
    if (!cur || cur.filterHash !== filterHash) {
      return {
        status: 400 as const,
        body: { error: { code: "bad_cursor", message: "Cursor does not match current filters", position: 0 } },
      };
    }
    cursorClause = ` AND (a.published_at, a.id) < ($${nextIdx}::timestamptz, $${nextIdx + 1}::bigint)`;
    params.push(cur.publishedAt, cur.id);
    nextIdx += 2;
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}${cursorClause}` : `WHERE true${cursorClause}`;

  // matched_in is a set of sides; evaluated only for returned rows (outer SELECT).
  const sideParts: string[] = [];
  if (compiled.originalSql) {
    sideParts.push(
      `CASE WHEN (${compiled.originalSql}) THEN 'original'::text END`,
    );
  }
  if (compiled.translationSql) {
    sideParts.push(
      `CASE WHEN (${compiled.translationSql}) THEN 'translation'::text END`,
    );
  }
  if (compiled.summarySql) {
    sideParts.push(
      `CASE WHEN (${compiled.summarySql}) THEN 'summary'::text END`,
    );
  }
  const matchedInExpr =
    sideParts.length > 0
      ? `array_remove(ARRAY[${sideParts.join(", ")}], NULL)`
      : `ARRAY['original']::text[]`;

  const listSql = `
    SELECT a.id, a.external_id, a.source, a.language, a.published_at,
           a.headline, left(a.body, 600) AS body_excerpt, a.flags, a.ingested_at,
           a.version,
           tr.headline_en,
           left(tr.body_en, 600) AS body_excerpt_en,
           (${matchedInExpr}) AS matched_in
      FROM articles a
      LEFT JOIN article_translations tr
        ON tr.article_id = a.id
       AND tr.article_version = a.version
       AND tr.superseded_at IS NULL
       AND tr.target_lang = 'en'
      ${where}
     ORDER BY a.published_at DESC, a.id DESC
     LIMIT $${nextIdx}
  `;
  params.push(limit + 1);

  const started = performance.now();
  let rows: pg.QueryResultRow[];
  try {
    const res = await db.query(listSql, params);
    rows = res.rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("statement timeout") || msg.includes("canceling statement")) {
      return {
        status: 503 as const,
        body: { error: { code: "timeout", message: "That search took too long. Try narrowing the date range or removing a wildcard." } },
      };
    }
    throw err;
  }
  const queryMs = performance.now() - started;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const ids = page.map((r) => r.id as string);

  // After list: page hydrate + corpus signals + filtered coverage in parallel (ADR-0036 / review 0005).
  const [hydrate, corpusSignals, filteredCov] = await Promise.all([
    hydratePage(db, ids),
    readCorpusSignals(db),
    computeFilteredCoverage(db, filters),
  ]);

  const articles = page.map((r) => {
    const rawMatched = r.matched_in;
    let matchedIn: string[];
    if (Array.isArray(rawMatched)) {
      matchedIn = rawMatched.map(String).filter(Boolean);
    } else if (typeof rawMatched === "string" && rawMatched.length) {
      matchedIn = rawMatched === "both" ? ["original", "translation"] : [rawMatched];
    } else {
      matchedIn = ["original"];
    }
    return {
      id: String(r.id),
      external_id: r.external_id,
      source: r.source,
      language: r.language,
      published_at: r.published_at,
      headline: r.headline,
      body_excerpt: r.body_excerpt,
      body_excerpt_en: (r.body_excerpt_en as string | null) ?? null,
      flags: r.flags,
      ingested_at: r.ingested_at,
      version: Number(r.version ?? 1),
      headline_en: (r.headline_en as string | null) ?? null,
      matched_in: matchedIn,
      derived: hydrate.derivedBy.get(String(r.id)) ?? [],
      jobs: hydrate.jobsBy.get(String(r.id)) ?? [],
    };
  });

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1]!;
    nextCursor = encodeCursor(
      {
        publishedAt: new Date(last.published_at as string).toISOString(),
        id: String(last.id),
        filterHash,
      },
      config.cursorSecret,
    );
  }

  let coverage: SearchCoverage | null = null;
  let translationCoverage: TranslationCoverage | null = null;
  let summaryMissing = 0;
  let trgmIndex = true;
  const echoNotes: string[] = [];

  if (corpusSignals && filteredCov) {
    coverage = {
      articles_matching_base_filters: filteredCov.articles_matching_base_filters,
      articles_in_scope: filteredCov.articles_in_scope,
      corpus_articles: corpusSignals.corpus_articles,
      enriched_sentiment: corpusSignals.enriched_sentiment,
      enriched_topics: corpusSignals.enriched_topics,
      excluded_by_filter_not_enriched: filteredCov.excluded_by_filter_not_enriched,
      watermark: corpusSignals.watermark,
    };
    translationCoverage = filteredCov.translation;
    summaryMissing = filteredCov.summary_missing;
    trgmIndex = corpusSignals.trgm_index;
  } else {
    echoNotes.push("Coverage figures are temporarily unavailable.");
    if (corpusSignals) trgmIndex = corpusSignals.trgm_index;
  }

  let total: number | undefined;
  if (sp.includeTotal) {
    const countParams = [...compiled.params, ...afterText.params];
    const countWhere = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "WHERE true";
    const c = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM articles a ${countWhere}`,
      countParams,
    );
    total = Number(c.rows[0]?.n ?? 0);
  }

  if (hasNonLatinTerm(parsed.ast)) {
    echoNotes.push(strings.nonLatinTermNote);
  }
  if (hasAndNot(parsed.ast)) {
    echoNotes.push(strings.notOriginalOnlyNote);
  }
  if (!trgmIndex && hasNonLatinTerm(parsed.ast)) {
    echoNotes.push("Partial-word matching is running slowly right now.");
  }
  if (summaryMissing > 0) {
    echoNotes.push(
      `${summaryMissing} articles in this selection have no summary yet, so English terms in summaries may miss them.`,
    );
  }

  return {
    status: 200 as const,
    body: {
      articles,
      next_cursor: nextCursor,
      parsed: echoAst(parsed.ast),
      echo_notes: echoNotes,
      coverage,
      translation_coverage: translationCoverage,
      summary_missing: summaryMissing,
      trgm_index: trgmIndex,
      search_kind: compiled.broadestKind,
      ...(total !== undefined ? { total } : {}),
      resolved_range: {
        from: filters.from?.toISOString() ?? null,
        to: filters.to?.toISOString() ?? null,
      },
    },
    timing: queryMs,
  };
}

function hasNonLatinTerm(ast: import("./parse").AstNode | null): boolean {
  if (!ast) return false;
  if (ast.type === "term") {
    const opts: { phrase?: boolean; wildcard?: boolean } = {};
    if (ast.phrase) opts.phrase = true;
    if (ast.wildcard) opts.wildcard = true;
    return classifyLeaf(ast.value, opts) === "substring";
  }
  if (ast.type === "and" || ast.type === "or" || ast.type === "and_not") {
    return hasNonLatinTerm(ast.left) || hasNonLatinTerm(ast.right);
  }
  return false;
}

function hasAndNot(ast: import("./parse").AstNode | null): boolean {
  if (!ast) return false;
  if (ast.type === "and_not") return true;
  if (ast.type === "and" || ast.type === "or") {
    return hasAndNot(ast.left) || hasAndNot(ast.right);
  }
  return false;
}

/** True when the query has a bare Latin term and no wildcard (UX zero-result hint). */
export function hasBareLatinNoWildcard(ast: import("./parse").AstNode | null): boolean {
  if (!ast) return false;
  let bareLatin = false;
  let hasWildcard = false;
  function walk(node: import("./parse").AstNode) {
    if (node.type === "term") {
      if (node.wildcard) hasWildcard = true;
      else if (!node.phrase && classifyLeaf(node.value) === "exact") bareLatin = true;
      return;
    }
    walk(node.left);
    walk(node.right);
  }
  walk(ast);
  return bareLatin && !hasWildcard;
}

async function hydratePage(
  db: pg.Pool | pg.PoolClient,
  ids: string[],
): Promise<{
  derivedBy: Map<string, pg.QueryResultRow[]>;
  jobsBy: Map<string, pg.QueryResultRow[]>;
}> {
  const derivedBy = new Map<string, pg.QueryResultRow[]>();
  const jobsBy = new Map<string, pg.QueryResultRow[]>();
  if (ids.length === 0) return { derivedBy, jobsBy };

  const res = await db.query<{ kind: string; payload: pg.QueryResultRow }>(
    `SELECT 'derived' AS kind, jsonb_build_object(
        'article_id', d.article_id,
        'field', d.field,
        'value', d.value,
        'confidence_norm', d.confidence_norm,
        'confidence_origin', d.confidence_origin,
        'method', d.method,
        'scale_min', d.scale_min,
        'scale_max', d.scale_max,
        'extra', d.extra
      ) AS payload
       FROM derived_values d
      WHERE d.article_id = ANY($1::bigint[]) AND d.is_current
     UNION ALL
     SELECT 'job' AS kind, jsonb_build_object(
        'article_id', j.article_id,
        'part', j.part,
        'state', j.state,
        'reason_code', j.reason_code
      ) AS payload
       FROM enrichment_jobs j
      WHERE j.article_id = ANY($1::bigint[])`,
    [ids],
  );
  for (const r of res.rows) {
    const row = r.payload;
    const k = String(row.article_id);
    if (r.kind === "derived") {
      const list = derivedBy.get(k) ?? [];
      list.push(row);
      derivedBy.set(k, list);
    } else {
      const list = jobsBy.get(k) ?? [];
      list.push(row);
      jobsBy.set(k, list);
    }
  }
  return { derivedBy, jobsBy };
}

type CorpusSignals = {
  corpus_articles: number;
  enriched_sentiment: number;
  enriched_topics: number;
  watermark: { published_at: string | null; ingested_at: string | null };
  trgm_index: boolean;
};

async function readCorpusSignals(db: pg.Pool | pg.PoolClient): Promise<CorpusSignals | null> {
  try {
    const res = await db.query<{ key: string; value: string }>(
      `SELECT key, value FROM system_flags WHERE key = ANY($1::text[])`,
      [COVERAGE_FLAG_KEYS],
    );
    const map = new Map(res.rows.map((r) => [r.key, r.value]));
    // Cold start: worker has not written coverage flags yet — treat as unavailable.
    if (!map.has("coverage_corpus_articles")) return null;
    const pub = map.get("coverage_watermark_published_at") ?? "";
    const ing = map.get("coverage_watermark_ingested_at") ?? "";
    return {
      corpus_articles: Number(map.get("coverage_corpus_articles") ?? 0),
      enriched_sentiment: Number(map.get("coverage_enriched_sentiment") ?? 0),
      enriched_topics: Number(map.get("coverage_enriched_topics") ?? 0),
      watermark: {
        published_at: pub.length ? pub : null,
        ingested_at: ing.length ? ing : null,
      },
      trgm_index: map.get("trgm_index") === "on",
    };
  } catch {
    return null;
  }
}

type FilteredCoverage = {
  articles_matching_base_filters: number;
  articles_in_scope: number;
  excluded_by_filter_not_enriched: number;
  summary_missing: number;
  translation: TranslationCoverage;
};

async function computeFilteredCoverage(
  db: pg.Pool | pg.PoolClient,
  filters: SearchFilters,
): Promise<FilteredCoverage | null> {
  try {
    const base = baseFiltersOnly(filters);
    const baseBuild = buildFilterClauses(base, 1);
    const fullBuild = buildFilterClauses(filters, baseBuild.nextIndex);
    const baseWhere = baseBuild.clauses.length
      ? `WHERE ${baseBuild.clauses.join(" AND ")}`
      : "WHERE true";
    const fullWhere = fullBuild.clauses.length
      ? `WHERE ${fullBuild.clauses.join(" AND ")}`
      : "WHERE true";
    const params = [...baseBuild.params, ...fullBuild.params];

    const derivedFilterActive = Boolean(
      (filters.sentiments && filters.sentiments.some((s) => s !== "not_enriched")) ||
        (filters.topics && filters.topics.some((t) => t !== "not_enriched")),
    );

    const res = await db.query<{
      base_count: string;
      sel_count: string;
      summary_missing: string;
      foreign: string;
      translated: string;
      queued: string;
      paused: string;
      failed: string;
      older_not_scheduled: string;
    }>(
      `WITH base AS (
         SELECT a.id, a.version, a.language
           FROM articles a
           ${baseWhere}
       ),
       sel AS (
         SELECT a.id, a.version, a.language
           FROM articles a
           ${fullWhere}
       ),
       foreign_sel AS (
         SELECT s.* FROM sel s
          WHERE lower(split_part(replace(coalesce(s.language,''), '_', '-'), '-', 1))
                NOT IN ('en', 'eng')
             OR coalesce(trim(s.language), '') = ''
       )
       SELECT
         (SELECT count(*)::text FROM base) AS base_count,
         (SELECT count(*)::text FROM sel) AS sel_count,
         (SELECT count(*)::text FROM sel s
           WHERE NOT EXISTS (
             SELECT 1 FROM derived_values dv
              WHERE dv.article_id = s.id AND dv.field = 'summary' AND dv.is_current
           )) AS summary_missing,
         (SELECT count(*)::text FROM foreign_sel) AS foreign,
         (SELECT count(*)::text FROM foreign_sel f
           JOIN article_translations t ON t.article_id = f.id AND t.article_version = f.version
            AND t.superseded_at IS NULL) AS translated,
         (SELECT count(*)::text FROM foreign_sel f
           JOIN enrichment_jobs j ON j.article_id = f.id AND j.article_version = f.version
            AND j.part = 'translation'
            AND j.state IN ('queued','running','failed_retryable')) AS queued,
         (SELECT count(*)::text FROM foreign_sel f
           JOIN enrichment_jobs j ON j.article_id = f.id AND j.article_version = f.version
            AND j.part = 'translation' AND j.state = 'deferred_budget') AS paused,
         (SELECT count(*)::text FROM foreign_sel f
           JOIN enrichment_jobs j ON j.article_id = f.id AND j.article_version = f.version
            AND j.part = 'translation' AND j.state = 'dead') AS failed,
         (SELECT count(*)::text FROM foreign_sel f
           WHERE NOT EXISTS (
             SELECT 1 FROM enrichment_jobs j
              WHERE j.article_id = f.id AND j.part = 'translation'
           )) AS older_not_scheduled`,
      params,
    );

    const r = res.rows[0];
    const baseCount = Number(r?.base_count ?? 0);
    const selCount = Number(r?.sel_count ?? 0);
    const excluded = derivedFilterActive ? Math.max(0, baseCount - selCount) : 0;

    return {
      articles_matching_base_filters: baseCount,
      articles_in_scope: selCount,
      excluded_by_filter_not_enriched: excluded,
      summary_missing: Number(r?.summary_missing ?? 0),
      translation: {
        selection: selCount,
        foreign: Number(r?.foreign ?? 0),
        translated: Number(r?.translated ?? 0),
        queued: Number(r?.queued ?? 0),
        paused: Number(r?.paused ?? 0),
        failed: Number(r?.failed ?? 0),
        older_not_scheduled: Number(r?.older_not_scheduled ?? 0),
      },
    };
  } catch {
    return null;
  }
}
