import { createHash } from "node:crypto";
import type pg from "pg";
import { buildSearchText, NORMALISER_VERSION } from "@/lib/normalise";
import { INFLECTION_PAIRS } from "../fixtures/articles";

/** Mulberry32 — same algorithm as bench-lib.mjs rng. */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n: number) => Math.floor(next() * n);
  next.pick = <T,>(arr: T[]): T => arr[next.int(arr.length)]!;
  return next;
}

const EN_WORDS = [
  "markets",
  "earnings",
  "growth",
  "regulators",
  "analysts",
  "investment",
  "demand",
  "report",
  "sector",
  "outlook",
  "startup",
  "startups",
  "enterprise",
  "enterprises",
  "news",
  "capital",
  "policy",
  "trade",
];
const AR_WORDS = ["الأسواق", "الأرباح", "النمو", "المنظمون", "المحللون", "الاستثمار"];
const ZH_WORDS = ["市场", "收益", "增长", "监管", "分析师", "投资"];
const FR_WORDS = ["marchés", "entreprises", "croissance", "investissement", "demande"];

export type SeedResult = {
  articles: number;
  foreign: number;
  translated: number;
  withSummary: number;
};

/**
 * Deterministic bulk loader for plan/golden tests.
 * ~30% foreign; foreign rows get a current mock translation; ~50% get a current summary.
 */
export async function seedArticles(
  pool: pg.Pool | pg.PoolClient,
  opts: { n: number; seed?: number; foreignShare?: number } = { n: 1000 },
): Promise<SeedResult> {
  const n = opts.n;
  const r = rng(opts.seed ?? 42);
  const foreignShare = opts.foreignShare ?? 0.3;
  const batchSize = 200;
  let foreign = 0;
  let translated = 0;
  let withSummary = 0;
  const startMs = Date.UTC(2026, 0, 1);

  for (let offset = 0; offset < n; offset += batchSize) {
    const chunk = Math.min(batchSize, n - offset);
    const rows: Array<{
      externalId: string;
      source: string;
      publishedAt: string;
      language: string;
      headline: string;
      body: string;
      searchText: string;
      contentHash: Buffer;
      foreign: boolean;
      plant: string | null;
    }> = [];

    for (let i = 0; i < chunk; i++) {
      const k = offset + i;
      const isForeign = r() < foreignShare;
      if (isForeign) foreign++;
      const lang = isForeign ? r.pick(["ar", "fr", "zh"]) : r.pick(["en", "en", "en-GB", "und"]);
      const words =
        lang === "ar" ? AR_WORDS : lang === "zh" ? ZH_WORDS : lang.startsWith("fr") ? FR_WORDS : EN_WORDS;
      const sep = lang === "zh" ? "" : " ";
      const wc = 20 + r.int(40);
      const parts: string[] = [];
      for (let w = 0; w < wc; w++) parts.push(r.pick(words));
      // Plant inflection pair ~1%
      let plant: string | null = null;
      if (!isForeign && r() < 0.01) {
        const pair = r.pick([...INFLECTION_PAIRS]);
        plant = pair[0];
        parts.splice(r.int(parts.length), 0, plant);
      }
      const headline = `${r.pick(words)} ${r.pick(words)} #${k}`;
      const body = parts.join(sep);
      const searchText = buildSearchText(headline, body);
      const contentHash = createHash("sha256").update(searchText).digest();
      rows.push({
        externalId: `seed-${k}`,
        source: "seed",
        publishedAt: new Date(startMs + k * 60_000).toISOString(),
        language: lang,
        headline,
        body,
        searchText,
        contentHash,
        foreign: isForeign,
        plant,
      });
    }

    // Bulk insert articles
    for (const row of rows) {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO articles (
           external_id, source, published_at, language, headline, body,
           content_hash, flags, search_text, search_text_ver, version
         ) VALUES ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8::text[],$9,$10,1)
         RETURNING id`,
        [
          row.externalId,
          row.source,
          row.publishedAt,
          row.language,
          row.headline,
          row.body,
          row.contentHash,
          "{}",
          row.searchText,
          NORMALISER_VERSION,
        ],
      );
      const articleId = ins.rows[0]!.id;

      if (row.foreign) {
        const headlineEn = `EN ${row.headline}`;
        const bodyEn = `Translated: ${row.body.slice(0, 200)}`;
        const trSearch = buildSearchText(headlineEn, bodyEn);
        const enr = await pool.query<{ id: string }>(
          `INSERT INTO enrichments (
             article_id, article_version, part, provider, model, prompt_version, origin,
             input_hash, input_truncated, trust
           ) VALUES ($1,1,'translation','mock','mock','v1','mock',$2,false,'normal')
           RETURNING id`,
          [articleId, row.contentHash],
        );
        await pool.query(
          `INSERT INTO article_translations (
             article_id, article_version, target_lang, source_lang,
             headline_en, body_en, search_text, search_text_ver,
             enrichment_id, chunk_count, flags
           ) VALUES ($1,1,'en',$2,$3,$4,$5,$6,$7,1,'{}')`,
          [
            articleId,
            row.language,
            headlineEn,
            bodyEn,
            trSearch,
            NORMALISER_VERSION,
            enr.rows[0]!.id,
          ],
        );
        translated++;
      }

      if (r() < 0.5) {
        const summary =
          row.plant != null
            ? `Summary mentioning ${row.plant} and related topics.`
            : `Automated summary of article ${row.externalId}.`;
        const enr = await pool.query<{ id: string }>(
          `INSERT INTO enrichments (
             article_id, article_version, part, provider, model, prompt_version, origin,
             input_hash, input_truncated, trust
           ) VALUES ($1,1,'summary_topics','mock','mock','v1','mock',$2,false,'normal')
           RETURNING id`,
          [articleId, row.contentHash],
        );
        await pool.query(
          `INSERT INTO derived_values (
             enrichment_id, article_id, field, value,
             confidence_norm, confidence_raw, scale_min, scale_max,
             confidence_origin, method, is_current
           ) VALUES ($1,$2,'summary',$3,80,0.8,0,1,'mock','mock:extractive',true)`,
          [enr.rows[0]!.id, articleId, summary],
        );
        withSummary++;
      }
    }
  }

  await pool.query(`ANALYZE articles`);
  await pool.query(`ANALYZE article_translations`);
  await pool.query(`ANALYZE derived_values`);

  const { refreshCoverageFlags } = await import("@/worker/metrics-refresh");
  await refreshCoverageFlags(pool);

  return { articles: n, foreign, translated, withSummary };
}
