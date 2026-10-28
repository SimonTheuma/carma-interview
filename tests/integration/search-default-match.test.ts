import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createTestDb } from "../harness/db";
import { buildSearchText, NORMALISER_VERSION } from "@/lib/normalise";
import { runSearch } from "@/lib/search/run";
import { searchMatchFixtures } from "../fixtures/articles";

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
  return (body as { articles: Array<{ id: string; external_id: string; matched_in?: string[]; body_excerpt_en?: string | null }> })
    .articles;
}

describe("search Amendment B goldens G1–G12", () => {
  it("golden cases", async () => {
    const db = await createTestDb();
    if (!db) return;

    try {
      const f = searchMatchFixtures;
      const idSingular = await insertArticle(db.pool, f.startupSingular);
      const idPlural = await insertArticle(db.pool, f.startupsPlural);
      await insertArticle(db.pool, f.renewableEn);
      await insertArticle(db.pool, f.renewablesEn);
      await insertArticle(db.pool, f.renewedEn);
      await insertArticle(db.pool, f.nonrenewableEn);
      await insertArticle(db.pool, f.mediaIntelligence);
      await insertArticle(db.pool, f.catsAndDogs);
      await insertArticle(db.pool, f.nestA);
      await insertArticle(db.pool, {
        ...f.frenchEntreprises,
        translation: { headlineEn: "Companies", bodyEn: "Large companies announce results." },
      });
      await insertArticle(db.pool, {
        ...f.arabicWithStartup,
        translation: {
          headlineEn: "News",
          bodyEn: "Sources said startups grew quickly in the region.",
        },
      });
      await insertArticle(db.pool, f.chineseTerm);
      await insertArticle(db.pool, f.undEnglish);
      await insertArticle(db.pool, f.enGb);
      await insertArticle(db.pool, {
        ...f.summaryOnly,
        summary: { value: f.summaryOnly.summary },
      });
      await insertArticle(db.pool, f.thePrefixBody);
      await insertArticle(db.pool, f.metaChars);

      // Translation-only renewable for G6
      await insertArticle(db.pool, {
        externalId: "g-tr-renewable",
        language: "ar",
        headline: "بدون",
        body: "نص بدون الكلمة الإنجليزية",
        translation: {
          headlineEn: "Energy",
          bodyEn: "The renewable pipeline expanded.",
        },
      });

      await insertArticle(db.pool, {
        externalId: "g-superseded-tr",
        language: "ar",
        headline: "بدون",
        body: "نص بدون الكلمة",
        translation: {
          headlineEn: "Old",
          bodyEn: "A unique xenonlegacy term only here",
          superseded: true,
        },
      });

      await insertArticle(db.pool, {
        externalId: "g-superseded-sum",
        language: "en",
        headline: "Plain",
        body: "No special words in body",
        summary: { value: "Contains xenonstale only", current: false },
      });

      const { refreshCoverageFlags } = await import("@/worker/metrics-refresh");
      await refreshCoverageFlags(db.pool);

      // G1: bare startups finds plural, not singular-only
      let res = await runSearch(db.pool, { q: "startups", limit: 50 });
      expect(res.status).toBe(200);
      let ids = new Set(artsOf(res.body).map((a) => a.id));
      expect(ids.has(idPlural)).toBe(true);
      expect(ids.has(idSingular)).toBe(false);

      // G2: startup* / startups* find both; renew* finds forms but not nonrenewable
      res = await runSearch(db.pool, { q: "startup*", limit: 50 });
      ids = new Set(artsOf(res.body).map((a) => a.id));
      expect(ids.has(idSingular)).toBe(true);
      expect(ids.has(idPlural)).toBe(true);

      res = await runSearch(db.pool, { q: "startups*", limit: 50 });
      ids = new Set(artsOf(res.body).map((a) => a.id));
      expect(ids.has(idSingular)).toBe(true);
      expect(ids.has(idPlural)).toBe(true);

      res = await runSearch(db.pool, { q: "renew*", limit: 50 });
      let ext = new Set(artsOf(res.body).map((a) => a.external_id));
      expect(ext.has("g-renewable")).toBe(true);
      expect(ext.has("g-renewables")).toBe(true);
      expect(ext.has("g-renewed")).toBe(true);
      expect(ext.has("g-nonrenewable")).toBe(false);

      // G3: phrase
      res = await runSearch(db.pool, { q: '"media intelligence"', limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-media-intel")).toBe(true);

      // G4: lowercase "and" is a term
      res = await runSearch(db.pool, { q: "cats and dogs", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-cats-and-dogs")).toBe(true);
      res = await runSearch(db.pool, { q: "cats OR dogs", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-cats-and-dogs")).toBe(true);

      // G5: nested brackets
      res = await runSearch(db.pool, { q: "(alpha AND (beta OR gamma))", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-nest-a")).toBe(true);

      // G6: wildcard on translation and summary; summary-only matched_in
      res = await runSearch(db.pool, { q: "renew*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-tr-renewable")).toBe(true);

      res = await runSearch(db.pool, { q: "xenonwidget", limit: 50 });
      const sumHit = artsOf(res.body).find((a) => a.external_id === "g-summary-only");
      expect(sumHit).toBeTruthy();
      expect(sumHit!.matched_in).toContain("summary");

      // G7: Arabic original with Latin "startups" — prefix finds, stem half does not
      // (prefix of startup* matches "startups" in the Arabic body)
      res = await runSearch(db.pool, { q: "startup*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-ar-startup-loanword")).toBe(true);

      // und / en-GB are stemmed for * queries
      res = await runSearch(db.pool, { q: "startups*", limit: 50 });
      ext = new Set(artsOf(res.body).map((a) => a.external_id));
      expect(ext.has("g-und-en")).toBe(true);
      expect(ext.has("g-en-gb")).toBe(true);

      // G8: NOT renew* is original-only — summary/translation hits do not exclude
      res = await runSearch(db.pool, { q: "quiet AND NOT renew*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-summary-only")).toBe(true);

      // G9: superseded translation and summary never match
      res = await runSearch(db.pool, { q: "xenonlegacy", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-superseded-tr")).toBe(false);
      res = await runSearch(db.pool, { q: "xenonstale", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-superseded-sum")).toBe(false);

      // G10: the* prefix matches theatre; short a* rejected by parser
      res = await runSearch(db.pool, { q: "the*", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-the-prefix")).toBe(true);
      res = await runSearch(db.pool, { q: "a*", limit: 50 });
      expect(res.status).toBe(400);

      // G11: metacharacters literal
      res = await runSearch(db.pool, { q: "100%_complete\\path", limit: 50 });
      expect(res.status).toBe(200);
      expect(artsOf(res.body).some((a) => a.external_id === "g-meta")).toBe(true);

      // G12: Arabic / Chinese unchanged path (non-Latin substring)
      res = await runSearch(db.pool, { q: "房地产", limit: 50 });
      expect(artsOf(res.body).some((a) => a.external_id === "g-zh")).toBe(true);

      // body_excerpt_en present when translation exists
      res = await runSearch(db.pool, { q: "entreprises", limit: 50 });
      const fr = artsOf(res.body).find((a) => a.external_id === "g-fr-entreprises");
      expect(fr?.body_excerpt_en).toBeTruthy();
    } finally {
      await db.end();
    }
  }, 120_000);
});
