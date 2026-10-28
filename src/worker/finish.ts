import { createHash } from "node:crypto";
import type pg from "pg";
import { VOCAB_VERSION } from "../lib/enrich/topics";
import { buildSearchText, NORMALISER_VERSION } from "../lib/normalise";
import type { SentimentResult, SummaryTopicsResult } from "../lib/providers/types";
import type { EnrichmentPart } from "../lib/translate/part";
import { releaseBudget, settleBudget } from "./budget";
import { markSupersededVersion } from "./claim";

type FinishBase = {
  jobId: string;
  articleId: string;
  articleVersion: number;
  workerId: string;
  promptVersion: string;
  inputHash: Buffer;
  truncated: boolean;
  trust: "normal" | "low";
  reservedMicro: number;
  providerBudgetKey: string;
  dayUtc: string;
};

/** Advisory lock + version check; returns false if job was superseded. */
async function guardVersion(db: pg.PoolClient, opts: FinishBase): Promise<boolean> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('article'), $1::integer)`, [
    Number(opts.articleId),
  ]);
  const cur = await db.query<{ version: number }>(
    `SELECT version FROM articles WHERE id = $1`,
    [opts.articleId],
  );
  const version = cur.rows[0]?.version ?? 1;
  if (version !== opts.articleVersion) {
    const marked = await markSupersededVersion(db, opts.jobId, opts.workerId);
    await releaseBudget(
      db,
      opts.providerBudgetKey,
      opts.dayUtc,
      marked?.reservedMicro ?? opts.reservedMicro,
    );
    return false;
  }
  return true;
}

async function claimOrRelease(
  db: pg.PoolClient,
  opts: FinishBase,
): Promise<boolean> {
  if (!(await guardVersion(db, opts))) return false;

  const updated = await db.query(
    `UPDATE enrichment_jobs
        SET state = 'succeeded', reserved_micro = 0, updated_at = now(),
            claimed_by = NULL, claim_expires_at = NULL
      WHERE id = $1 AND claimed_by = $2 AND state = 'running'`,
    [opts.jobId, opts.workerId],
  );
  if (updated.rowCount !== 1) {
    await releaseBudget(db, opts.providerBudgetKey, opts.dayUtc, opts.reservedMicro);
    return false;
  }
  return true;
}

export async function finishSentiment(
  db: pg.PoolClient,
  opts: FinishBase & {
    result: SentimentResult;
    costMicro: number;
  },
): Promise<boolean> {
  if (!(await claimOrRelease(db, opts))) return false;

  const { result } = opts;
  const enr = await db.query<{ id: string }>(
    `INSERT INTO enrichments (
       article_id, article_version, part, provider, model, model_reported, prompt_version, origin,
       input_hash, input_truncated, input_tokens, output_tokens, cost_micro, trust, raw_output, job_id
     ) VALUES ($1,$2,'sentiment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     RETURNING id`,
    [
      opts.articleId,
      opts.articleVersion,
      result.origin === "mock" ? "mock" : "jev",
      result.model,
      result.modelReported ?? null,
      opts.promptVersion,
      result.origin,
      opts.inputHash,
      opts.truncated,
      result.usage.inputTokens ?? null,
      result.usage.outputTokens ?? null,
      opts.costMicro,
      opts.trust,
      JSON.stringify(result.raw).slice(0, 8000),
      opts.jobId,
    ],
  );
  const enrichmentId = enr.rows[0]!.id;
  const conf = result.value.confidence;
  await db.query(
    `UPDATE derived_values SET is_current = false
      WHERE article_id = $1 AND field = 'sentiment' AND is_current`,
    [opts.articleId],
  );
  await db.query(
    `INSERT INTO derived_values (
       enrichment_id, article_id, field, value, confidence_norm, confidence_raw,
       scale_min, scale_max, confidence_origin, method, extra, is_current
     ) VALUES ($1,$2,'sentiment',$3,$4,$5,0,1,$6,$7,$8::jsonb,true)`,
    [
      enrichmentId,
      opts.articleId,
      result.value.choice,
      Math.round(conf * 10000) / 100,
      conf,
      result.origin === "mock" ? "mock" : "classifier_concentration",
      result.origin === "mock" ? "mock:lexicon" : "jev:choice",
      JSON.stringify({ probabilities: result.value.probabilities ?? null }),
    ],
  );
  await settleBudget(
    db,
    opts.providerBudgetKey,
    opts.dayUtc,
    opts.reservedMicro,
    opts.costMicro,
  );
  return true;
}

export async function finishSummaryTopics(
  db: pg.PoolClient,
  opts: FinishBase & {
    result: SummaryTopicsResult;
    costMicro: number;
  },
): Promise<boolean> {
  if (!(await claimOrRelease(db, opts))) return false;

  const { result } = opts;
  const enr = await db.query<{ id: string }>(
    `INSERT INTO enrichments (
       article_id, article_version, part, provider, model, model_reported, prompt_version, origin,
       input_hash, input_truncated, input_tokens, output_tokens, cost_micro, trust, raw_output, job_id
     ) VALUES ($1,$2,'summary_topics',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     RETURNING id`,
    [
      opts.articleId,
      opts.articleVersion,
      result.origin === "mock" ? "mock" : "openai",
      result.model,
      result.modelReported ?? null,
      opts.promptVersion,
      result.origin,
      opts.inputHash,
      opts.truncated,
      result.usage.inputTokens ?? null,
      result.usage.outputTokens ?? null,
      opts.costMicro,
      opts.trust,
      JSON.stringify(result.raw).slice(0, 8000),
      opts.jobId,
    ],
  );
  const enrichmentId = enr.rows[0]!.id;
  const confOrigin = result.origin === "mock" ? "mock" : "llm_self_report";
  const method = result.origin === "mock" ? "mock:extractive" : "openai:structured";

  // FP-DB6: flip previous current summary/topics before inserting the new ones
  await db.query(
    `UPDATE derived_values SET is_current = false
      WHERE article_id = $1 AND field IN ('summary', 'topic') AND is_current`,
    [opts.articleId],
  );

  await db.query(
    `INSERT INTO derived_values (
       enrichment_id, article_id, field, value, confidence_norm, confidence_raw,
       scale_min, scale_max, confidence_origin, method, is_current
     ) VALUES ($1,$2,'summary',$3,$4,$5,0,1,$6,$7,true)`,
    [
      enrichmentId,
      opts.articleId,
      result.value.summary,
      Math.round(result.value.summary_confidence * 10000) / 100,
      result.value.summary_confidence,
      confOrigin,
      method,
    ],
  );

  let rank = 1;
  for (const t of result.value.topics) {
    await db.query(
      `INSERT INTO derived_values (
         enrichment_id, article_id, field, value, rank, vocab_version,
         confidence_norm, confidence_raw, scale_min, scale_max,
         confidence_origin, method, is_current
       ) VALUES ($1,$2,'topic',$3,$4,$5,$6,$7,0,1,$8,$9,true)`,
      [
        enrichmentId,
        opts.articleId,
        t.name,
        rank++,
        VOCAB_VERSION,
        Math.round(t.confidence * 10000) / 100,
        t.confidence,
        confOrigin,
        method,
      ],
    );
  }

  await settleBudget(
    db,
    opts.providerBudgetKey,
    opts.dayUtc,
    opts.reservedMicro,
    opts.costMicro,
  );
  return true;
}

export async function finishTranslation(
  db: pg.PoolClient,
  opts: FinishBase & {
    headlineEn: string | null;
    bodyEn: string | null;
    sourceLang: string | null;
    detectedLang: string | null;
    chunkCount: number;
    flags: string[];
    costMicro: number;
    model: string;
    modelReported?: string | null;
    origin: "provider" | "mock" | "cache";
    usage: { inputTokens?: number; outputTokens?: number };
  },
): Promise<boolean> {
  if (!(await guardVersion(db, opts))) return false;

  await db.query(
    `UPDATE article_translations SET superseded_at = now()
      WHERE article_id = $1 AND superseded_at IS NULL`,
    [opts.articleId],
  );

  const rawOutput = {
    usage: opts.usage,
    model_reported: opts.modelReported ?? null,
    chunk_count: opts.chunkCount,
  };

  const enr = await db.query<{ id: string }>(
    `INSERT INTO enrichments (
       article_id, article_version, part, provider, model, model_reported, prompt_version, origin,
       input_hash, input_truncated, input_tokens, output_tokens, cost_micro, trust, raw_output, job_id
     ) VALUES ($1,$2,'translation',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
     RETURNING id`,
    [
      opts.articleId,
      opts.articleVersion,
      opts.origin === "mock" ? "mock" : opts.origin === "cache" ? "mock" : "openai",
      opts.model,
      opts.modelReported ?? null,
      opts.promptVersion,
      opts.origin,
      opts.inputHash,
      opts.truncated,
      opts.usage.inputTokens ?? null,
      opts.usage.outputTokens ?? null,
      opts.costMicro,
      opts.trust,
      JSON.stringify(rawOutput),
      opts.jobId,
    ],
  );
  const enrichmentId = enr.rows[0]!.id;

  const searchText = buildSearchText(opts.headlineEn, opts.bodyEn);
  try {
    await db.query(
      `INSERT INTO article_translations (
         article_id, article_version, target_lang, source_lang, detected_lang,
         headline_en, body_en, search_text, search_text_ver, enrichment_id, chunk_count, flags
       ) VALUES ($1,$2,'en',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        opts.articleId,
        opts.articleVersion,
        opts.sourceLang,
        opts.detectedLang,
        opts.headlineEn,
        opts.bodyEn,
        searchText,
        NORMALISER_VERSION,
        enrichmentId,
        opts.chunkCount,
        opts.flags,
      ],
    );
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "23505") {
      // Unique conflict: treat as done if version/enrichment already match
      const existing = await db.query<{ enrichment_id: string; article_version: number }>(
        `SELECT enrichment_id, article_version FROM article_translations
          WHERE article_id = $1 AND superseded_at IS NULL`,
        [opts.articleId],
      );
      const row = existing.rows[0];
      if (
        row &&
        Number(row.article_version) === opts.articleVersion &&
        String(row.enrichment_id) === enrichmentId
      ) {
        // fall through to succeed job
      } else if (row && Number(row.article_version) === opts.articleVersion) {
        // same version, different enrichment — supersede and we already inserted enrichment; skip
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const updated = await db.query(
    `UPDATE enrichment_jobs
        SET state = 'succeeded', reserved_micro = 0, updated_at = now(),
            claimed_by = NULL, claim_expires_at = NULL
      WHERE id = $1 AND claimed_by = $2 AND state = 'running'`,
    [opts.jobId, opts.workerId],
  );
  if (updated.rowCount !== 1) {
    await releaseBudget(db, opts.providerBudgetKey, opts.dayUtc, opts.reservedMicro);
    return false;
  }

  await db.query(`DELETE FROM translation_chunk_cache WHERE job_id = $1`, [opts.jobId]);

  await settleBudget(
    db,
    opts.providerBudgetKey,
    opts.dayUtc,
    opts.reservedMicro,
    opts.costMicro,
  );
  return true;
}

/** Reuse a prior enrichment by input_hash: new row with origin=cache, cost 0. */
export async function finishFromCache(
  db: pg.PoolClient,
  opts: FinishBase & {
    part: EnrichmentPart;
    cachedEnrichmentId: string;
  },
): Promise<boolean> {
  const cached = await db.query<{
    provider: string;
    model: string;
    model_reported: string | null;
    prompt_version: string;
    raw_output: unknown;
    trust: string;
  }>(
    `SELECT provider, model, model_reported, prompt_version, raw_output, trust
       FROM enrichments WHERE id = $1`,
    [opts.cachedEnrichmentId],
  );
  const src = cached.rows[0];
  if (!src) {
    throw new Error("cache source enrichment missing");
  }

  if (!(await claimOrRelease(db, opts))) return false;

  const enr = await db.query<{ id: string }>(
    `INSERT INTO enrichments (
       article_id, article_version, part, provider, model, model_reported, prompt_version, origin,
       input_hash, input_truncated, input_tokens, output_tokens, cost_micro, trust, raw_output, job_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'cache',$8,$9,NULL,NULL,0,$10,$11::jsonb,$12)
     RETURNING id`,
    [
      opts.articleId,
      opts.articleVersion,
      opts.part,
      src.provider,
      src.model,
      src.model_reported,
      src.prompt_version,
      opts.inputHash,
      opts.truncated,
      opts.trust,
      JSON.stringify(src.raw_output ?? null).slice(0, 8000),
      opts.jobId,
    ],
  );
  const enrichmentId = enr.rows[0]!.id;

  const dvs = await db.query<{
    field: string;
    value: string;
    rank: number | null;
    vocab_version: number | null;
    confidence_norm: string | null;
    confidence_raw: number | null;
    scale_min: number | null;
    scale_max: number | null;
    confidence_origin: string;
    method: string;
    extra: unknown;
  }>(
    `SELECT field, value, rank, vocab_version, confidence_norm, confidence_raw,
            scale_min, scale_max, confidence_origin, method, extra
       FROM derived_values WHERE enrichment_id = $1 AND is_current`,
    [opts.cachedEnrichmentId],
  );

  for (const dv of dvs.rows) {
    await db.query(
      `INSERT INTO derived_values (
         enrichment_id, article_id, field, value, rank, vocab_version,
         confidence_norm, confidence_raw, scale_min, scale_max,
         confidence_origin, method, extra, is_current
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,true)`,
      [
        enrichmentId,
        opts.articleId,
        dv.field,
        dv.value,
        dv.rank,
        dv.vocab_version,
        dv.confidence_norm,
        dv.confidence_raw,
        dv.scale_min,
        dv.scale_max,
        dv.confidence_origin,
        dv.method,
        dv.extra != null ? JSON.stringify(dv.extra) : null,
      ],
    );
  }

  await releaseBudget(db, opts.providerBudgetKey, opts.dayUtc, opts.reservedMicro);
  return true;
}

export function hashInput(text: string, promptVersion: string): Buffer {
  return createHash("sha256").update(`${promptVersion}\n${text}`).digest();
}
