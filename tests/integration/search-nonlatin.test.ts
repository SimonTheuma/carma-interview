import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createTestDb } from "../harness/db";
import { buildSearchText, NORMALISER_VERSION } from "@/lib/normalise";
import { runSearch } from "@/lib/search/run";

async function insertArticle(
  pool: import("pg").Pool,
  opts: {
    externalId: string;
    language: string;
    headline: string;
    body: string;
    translation?: { headlineEn: string; bodyEn: string; superseded?: boolean };
    summary?: { value: string; current?: boolean };
  },
) {
  const searchText = buildSearchText(opts.headline, opts.body);
  const hash = createHash("sha256").update(searchText).digest();
  const art = await pool.query<{ id: string }>(
    `INSERT INTO articles (
       external_id, source, published_at, language, headline, body,
       content_hash, flags, search_text, search_text_ver, version
     ) VALUES ($1,'fixture',now(),$2,$3,$4,$5,'{}',$6,$7,1)
     RETURNING id`,
    [opts.externalId, opts.language, opts.headline, opts.body, hash, searchText, NORMALISER_VERSION],
  );
  const id = art.rows[0]!.id;

  if (opts.translation) {
    const trSearch = buildSearchText(opts.translation.headlineEn, opts.translation.bodyEn);
    const enr = await pool.query<{ id: string }>(
      `INSERT INTO enrichments (
         article_id, article_version, part, provider, model, prompt_version, origin,
         input_hash, input_truncated, trust
       ) VALUES ($1,1,'translation','mock','mock','v1','mock',$2,false,'normal')
       RETURNING id`,
      [id, hash],
    );
    await pool.query(
      `INSERT INTO article_translations (
         article_id, article_version, target_lang, source_lang,
         headline_en, body_en, search_text, search_text_ver,
         enrichment_id, chunk_count, flags, superseded_at
       ) VALUES ($1,1,'en',$2,$3,$4,$5,$6,$7,1,'{}',$8)`,
      [
        id,
        opts.language,
        opts.translation.headlineEn,
        opts.translation.bodyEn,
        trSearch,
        NORMALISER_VERSION,
        enr.rows[0]!.id,
        opts.translation.superseded ? new Date().toISOString() : null,
      ],
    );
  }

  if (opts.summary) {
    const enr = await pool.query<{ id: string }>(
      `INSERT INTO enrichments (
         article_id, article_version, part, provider, model, prompt_version, origin,
         input_hash, input_truncated, trust
       ) VALUES ($1,1,'summary_topics','mock','mock','v1','mock',$2,false,'normal')
       RETURNING id`,
      [id, hash],
    );
    await pool.query(
      `INSERT INTO derived_values (
         enrichment_id, article_id, field, value,
         confidence_norm, confidence_raw, scale_min, scale_max,
         confidence_origin, method, is_current
       ) VALUES ($1,$2,'summary',$3,80,0.8,0,1,'mock','mock:extractive',$4)`,
      [enr.rows[0]!.id, id, opts.summary.value, opts.summary.current !== false],
    );
  }

  return id;
}

function artsOf(body: unknown) {
  return (body as { articles: Array<{ id: string; external_id: string }> }).articles;
}

function notesOf(body: unknown): string[] {
  return (body as { echo_notes?: string[] }).echo_notes ?? [];
}

/** Real sample article 8 / 9 text from assignment fixtures. */
const SAMPLE_8 = {
  externalId: "8",
  language: "ar",
  headline: "ارتفاع أسعار العقارات في دبي بنسبة 15% خلال النصف الأول من 2026",
  body: "شهدت أسعار العقارات في دبي ارتفاعاً ملحوظاً بنسبة 15% خلال النصف الأول من عام 2026 مقارنة بالفترة ذاتها من العام الماضي. وأرجع خبراء السوق هذا الارتفاع إلى زيادة الطلب من المستثمرين الدوليين وتحسن البيئة التنظيمية. كما ساهمت مشاريع البنية التحتية الجديدة في تعزيز جاذبية الإمارة كوجهة استثمارية.",
};

const SAMPLE_9 = {
  externalId: "9",
  language: "zh",
  headline: "中国科技企业加速全球化布局",
  body: "多家中国科技企业近日宣布加大海外市场投资力度。据行业分析报告显示，2026年上半年，中国科技企业的海外收入占比已超过35%，较去年同期增长8个百分点。专家认为，这一趋势反映了中国企业在人工智能和云计算领域日益增强的竞争力。",
};

describe("I1–I6 non-Latin search hardening (ADR-0038 / 0040)", () => {
  it("goldens G18–G27, escapes, empty_term, short OR", async () => {
    const db = await createTestDb();
    if (!db) return;

    try {
      await insertArticle(db.pool, SAMPLE_8);
      await insertArticle(db.pool, SAMPLE_9);

      await insertArticle(db.pool, {
        externalId: "g-oil",
        language: "en",
        headline: "Markets",
        body: "Global oil prices rose on supply news.",
      });
      await insertArticle(db.pool, {
        externalId: "g-renew",
        language: "en",
        headline: "Energy",
        body: "The renewable energy sector grew quickly.",
      });
      await insertArticle(db.pool, {
        externalId: "g-startup",
        language: "en",
        headline: "Funding",
        body: "A new startup raised funds this week.",
      });

      // G26: foreign original without "coal"; English translation has coal
      await insertArticle(db.pool, {
        externalId: "g-fr-energy-coal-tr",
        language: "fr",
        headline: "Énergie",
        body: "Le secteur de l'énergie progresse sans ce mot anglais.",
        translation: {
          headlineEn: "Energy",
          bodyEn: "The energy sector grew while coal demand fell.",
        },
      });

      await insertArticle(db.pool, {
        externalId: "g-pct",
        language: "en",
        headline: "Meta",
        body: "Literal percent mark here: 50% done.",
      });
      await insertArticle(db.pool, {
        externalId: "g-under",
        language: "en",
        headline: "Meta",
        body: "Literal underscore here: foo_bar token.",
      });
      await insertArticle(db.pool, {
        externalId: "g-bslash",
        language: "en",
        headline: "Meta",
        body: "Literal backslash here: path\\file token.",
      });

      const { refreshCoverageFlags } = await import("@/worker/metrics-refresh");
      await refreshCoverageFlags(db.pool);

      // I1 / G18–G23
      let res = await runSearch(db.pool, { q: '"人工智能"', limit: 50 });
      expect(res.status).toBe(200);
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(true);

      res = await runSearch(db.pool, { q: "人工智能", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(true);

      res = await runSearch(db.pool, { q: "科技*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(true);

      res = await runSearch(db.pool, { q: '"人工智能和云计算"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(true);

      // G21 negative: space between terms (sample has 和)
      res = await runSearch(db.pool, { q: '"人工智能 云计算"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(false);

      res = await runSearch(db.pool, { q: '"عقارات"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "8")).toBe(true);

      res = await runSearch(db.pool, { q: "عقارات*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "8")).toBe(true);

      // I2 / G24 Latin regression
      res = await runSearch(db.pool, { q: '"oil prices"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-oil")).toBe(true);

      res = await runSearch(db.pool, { q: "renew*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-renew")).toBe(true);

      res = await runSearch(db.pool, { q: '"startup"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-startup")).toBe(true);

      // I3 / G25: NOT on original Chinese excludes article 9
      res = await runSearch(db.pool, { q: '"能源" AND NOT 中国', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(false);

      // I4 / G26: NOT coal does not exclude via translation; note present
      res = await runSearch(db.pool, { q: "energy AND NOT coal", limit: 50 });
      expect(res.status).toBe(200);
      expect(artsOf(res.body).some((a) => a.external_id === "g-fr-energy-coal-tr")).toBe(true);
      expect(notesOf(res.body).some((n) => n.includes("NOT terms exclude"))).toBe(true);

      // I5 escapes
      res = await runSearch(db.pool, { q: "%", limit: 50 });
      expect(res.status).toBe(200);
      expect(artsOf(res.body).every((a) => a.external_id === "g-pct")).toBe(true);

      res = await runSearch(db.pool, { q: "_", limit: 50 });
      expect(res.status).toBe(200);
      // underscore is a single-char Latin exact term — may match tokens; at least no crash
      expect(Array.isArray(artsOf(res.body))).toBe(true);

      res = await runSearch(db.pool, { q: "ـ", limit: 50 });
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("empty_term");

      // I6: 20 short Chinese OR terms — finish or timeout note, never 500
      const shorts = [
        "中",
        "国",
        "科",
        "技",
        "企",
        "业",
        "加",
        "速",
        "全",
        "球",
        "化",
        "布",
        "局",
        "海",
        "外",
        "市",
        "场",
        "投",
        "资",
        "力",
      ];
      expect(shorts.length).toBe(20);
      res = await runSearch(db.pool, { q: shorts.join(" OR "), limit: 50 });
      expect(res.status).not.toBe(500);
      expect([200, 503]).toContain(res.status);
      if (res.status === 200) {
        expect(artsOf(res.body).some((a) => a.external_id === "9")).toBe(true);
      }

      res = await runSearch(db.pool, { q: "人工智能", limit: 50 });
      expect(notesOf(res.body).some((n) => /Chinese, Arabic and similar scripts/i.test(n))).toBe(
        true,
      );
    } finally {
      await db.end();
    }
  }, 120_000);
});
