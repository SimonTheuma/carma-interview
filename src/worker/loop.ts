import { createHash } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "../lib/config";
import type { Clock } from "../lib/clock";
import { log } from "../lib/log";
import { detectInjection } from "../lib/enrich/inject-detect";
import { createProviders } from "../lib/providers";
import type { EnrichmentProviders } from "../lib/providers/types";
import { chunkForTranslation, estimateTokens } from "../lib/translate/chunk";
import { stripOutputBidi } from "../lib/translate/prompt";
import type { EnrichmentPart } from "../lib/translate/part";
import { validateTranslationOutput, parseTranslatePayload } from "../lib/translate/validate";
import { claimJobs, releaseUnchanged } from "./claim";
import { CircuitBreaker } from "./breaker";
import {
  ensureBudgetDay,
  reserveBudget,
  releaseBudget,
  dollarsToMicro,
  estimateCostMicro,
} from "./budget";
import {
  finishSentiment,
  finishSummaryTopics,
  finishFromCache,
  finishTranslation,
  hashInput,
} from "./finish";
import { classifyProviderError, formatLastError } from "./classify";
import { maxAttemptsFor, nextDelayMs } from "./retry";
import { sweepExpired, sweepTranslationRetention } from "./sweeper";

export async function runWorkerLoop(opts: {
  pool: pg.Pool;
  config: AppConfig;
  clock: Clock;
  shouldStop: () => boolean;
}): Promise<void> {
  const { pool, config, clock, shouldStop } = opts;
  const workerId = `worker-${process.pid}`;
  const providers = createProviders(config);
  const breakers = {
    jev: new CircuitBreaker("jev"),
    openai: new CircuitBreaker("openai"),
    translate: new CircuitBreaker("openai-translate"),
  };

  while (!shouldStop()) {
    const flags = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM system_flags
        WHERE key IN ('enrichment_enabled', 'translation_enabled')`,
    );
    const flagMap = Object.fromEntries(flags.rows.map((r) => [r.key, r.value]));
    if (flagMap.enrichment_enabled === "false") {
      await clock.sleep(2000);
      continue;
    }

    await sweepExpired(pool);
    try {
      await sweepTranslationRetention(pool, config.translation);
    } catch (err) {
      log.warn({ err }, "translation retention sweep failed");
    }

    const parts: EnrichmentPart[] = ["sentiment", "summary_topics", "translation"];
    for (const part of parts) {
      if (shouldStop()) break;
      if (part === "translation" && flagMap.translation_enabled === "false") continue;

      const breaker =
        part === "sentiment"
          ? breakers.jev
          : part === "translation"
            ? breakers.translate
            : breakers.openai;
      const now = clock.now().getTime();
      if (!breaker.canRequest(now)) {
        await pool.query(`SELECT worker_set_flag($1, $2)`, [
          `breaker.${breaker.name}`,
          breaker.snapshot(),
        ]);
        continue;
      }

      const concurrency =
        breaker.state === "half_open"
          ? 1
          : part === "sentiment"
            ? config.workerConcurrency.jev
            : part === "translation"
              ? config.workerConcurrency.translate
              : config.workerConcurrency.openai;

      let jobs: Awaited<ReturnType<typeof claimJobs>> = [];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        jobs = await claimJobs(client, part, workerId, concurrency, config.claimVisibilitySeconds);
        if (jobs.length === 0) {
          await client.query("COMMIT");
          continue;
        }
        if (!breaker.canRequest(clock.now().getTime())) {
          for (const j of jobs) await releaseUnchanged(client, j.id, workerId);
          await client.query("COMMIT");
          continue;
        }
        if (breaker.state === "half_open") breaker.markProbeStarted();
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        log.error({ err }, "claim cycle failed");
        continue;
      } finally {
        // Release claim connection before provider calls (C8 / FP-V3)
        client.release();
      }

      for (const job of jobs) {
        if (job.part === "translation") {
          await processTranslationJob({
            pool,
            config,
            clock,
            providers,
            breaker,
            workerId,
            job,
          });
        } else {
          await processJob({
            pool,
            config,
            clock,
            providers,
            breaker,
            workerId,
            job,
          });
        }
      }
    }

    await clock.sleep(200);
  }
}

async function processJob(opts: {
  pool: pg.Pool;
  config: AppConfig;
  clock: Clock;
  providers: EnrichmentProviders;
  breaker: CircuitBreaker;
  workerId: string;
  job: {
    id: string;
    articleId: string;
    articleVersion: number;
    attempts: number;
    part: EnrichmentPart;
  };
}): Promise<void> {
  const { pool, config, clock, providers, breaker, workerId, job } = opts;
  const art = await pool.query<{
    headline: string | null;
    body: string | null;
    version: number;
  }>(`SELECT headline, body, version FROM articles WHERE id = $1`, [job.articleId]);
  const row = art.rows[0];
  if (!row) return;
  if (Number(row.version) !== job.articleVersion) {
    await markJobSuperseded(pool, job.id, workerId);
    return;
  }
  const text = [row.headline, row.body].filter(Boolean).join("\n\n");
  const trust = detectInjection(text) ? "low" : "normal";

  const providerKey = job.part === "sentiment" ? "jev" : "openai";
  const dayUtc = clock.now().toISOString().slice(0, 10);
  const reserveMicro = dollarsToMicro(0.01);

  const reserved = await reserveOrDefer({
    pool,
    config,
    providerKey,
    dayUtc,
    reserveMicro,
    jobId: job.id,
    workerId,
  });
  if (!reserved) return;

  const inputHash = hashInput(text, config.promptVersion);
  const cached = await pool.query<{ id: string }>(
    `SELECT id FROM enrichments
      WHERE input_hash = $1 AND part = $2 AND superseded_at IS NULL
        AND article_id <> $3
      ORDER BY created_at DESC LIMIT 1`,
    [inputHash, job.part, job.articleId],
  );

  const finishBase = {
    jobId: job.id,
    articleId: job.articleId,
    articleVersion: job.articleVersion,
    workerId,
    promptVersion: config.promptVersion,
    inputHash,
    truncated: false as const,
    trust: trust as "normal" | "low",
    reservedMicro: reserveMicro,
    providerBudgetKey: providerKey,
    dayUtc,
  };

  try {
    let providerOutcome:
      | { kind: "cache"; cachedId: string }
      | {
          kind: "fresh";
          costMicro: number;
          result:
            | Awaited<ReturnType<EnrichmentProviders["classifySentiment"]>>
            | Awaited<ReturnType<EnrichmentProviders["summariseAndTag"]>>;
        };

    if (cached.rows[0]) {
      providerOutcome = { kind: "cache", cachedId: cached.rows[0].id };
    } else {
      const { costMicro, result } = await callProvider({
        job: { part: job.part as "sentiment" | "summary_topics" },
        providers,
        config,
        text,
        headline: row.headline,
      });
      providerOutcome = { kind: "fresh", costMicro, result };
    }

    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      let ok: boolean;
      if (providerOutcome.kind === "cache") {
        ok = await finishFromCache(c, {
          ...finishBase,
          part: job.part,
          cachedEnrichmentId: providerOutcome.cachedId,
        });
      } else if (job.part === "sentiment") {
        ok = await finishSentiment(c, {
          ...finishBase,
          result: providerOutcome.result as Awaited<
            ReturnType<EnrichmentProviders["classifySentiment"]>
          >,
          costMicro: providerOutcome.costMicro,
        });
      } else {
        ok = await finishSummaryTopics(c, {
          ...finishBase,
          result: providerOutcome.result as Awaited<
            ReturnType<EnrichmentProviders["summariseAndTag"]>
          >,
          costMicro: providerOutcome.costMicro,
        });
      }
      if (!ok) {
        await c.query("COMMIT");
        log.warn({ jobId: job.id }, "lost claim on finish; skipped enrichment write");
        return;
      }
      await c.query("COMMIT");
      breaker.onSuccess();
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await pool.query(`SELECT worker_set_flag($1, $2)`, [
      `breaker.${breaker.name}`,
      breaker.snapshot(),
    ]);
  } catch (err) {
    await recordFailure({
      pool,
      clock,
      breaker,
      providerKey,
      dayUtc,
      reserveMicro,
      workerId,
      job,
      config,
      err,
    });
  }
}

async function processTranslationJob(opts: {
  pool: pg.Pool;
  config: AppConfig;
  clock: Clock;
  providers: EnrichmentProviders;
  breaker: CircuitBreaker;
  workerId: string;
  job: {
    id: string;
    articleId: string;
    articleVersion: number;
    attempts: number;
    part: EnrichmentPart;
  };
}): Promise<void> {
  const { pool, config, clock, providers, breaker, workerId, job } = opts;
  const art = await pool.query<{
    headline: string | null;
    body: string | null;
    language: string;
    version: number;
  }>(`SELECT headline, body, language, version FROM articles WHERE id = $1`, [job.articleId]);
  const row = art.rows[0];
  if (!row) return;
  if (Number(row.version) !== job.articleVersion) {
    await markJobSuperseded(pool, job.id, workerId);
    return;
  }

  const chunked = chunkForTranslation(row.headline, row.body, {
    chunkTokens: config.translation.chunkTokens,
    maxChunks: config.translation.maxChunks,
  });
  if (!chunked.ok) {
    await markJobDead(pool, job.id, workerId, chunked.reason);
    return;
  }

  const sourceHadInjection = detectInjection(
    [row.headline, row.body].filter(Boolean).join("\n\n"),
  );
  const trust = sourceHadInjection ? "low" : "normal";
  const providerKey = "openai-translate";
  const dayUtc = clock.now().toISOString().slice(0, 10);

  let estimatedIn = 0;
  for (const ch of chunked.chunks) estimatedIn += estimateTokens(ch);
  const estimatedOut = Math.ceil(estimatedIn * 1.3);
  const priceIn = config.openai.priceInPerMtok ?? 0;
  const priceOut = config.openai.priceOutPerMtok ?? 0;
  const reserveMicro =
    config.openai.mode === "mock"
      ? 0
      : estimateCostMicro(estimatedIn, estimatedOut, priceIn, priceOut) || dollarsToMicro(0.01);

  if (reserveMicro > 0) {
    const reserved = await reserveOrDefer({
      pool,
      config,
      providerKey,
      dayUtc,
      reserveMicro,
      jobId: job.id,
      workerId,
    });
    if (!reserved) return;
  }

  const promptVersion = config.translation.promptVersion;
  const flags = new Set<string>();
  if (!row.language?.trim()) flags.add("lang_unknown");

  let totalIn = 0;
  let totalOut = 0;
  let model = "mock-translate-v1";
  let modelReported: string | undefined;
  let origin: "provider" | "mock" | "cache" = "mock";
  const outputs: string[] = [];
  let detectedLang: string | null = null;

  try {
    for (let i = 0; i < chunked.chunks.length; i++) {
      const chunk = chunked.chunks[i]!;
      const inputHash = createHash("sha256")
        .update(`${promptVersion}\n${chunk}`)
        .digest();

      const cached = await pool.query<{ output: string }>(
        `SELECT output FROM translation_chunk_cache
          WHERE job_id = $1 AND chunk_idx = $2 AND input_hash = $3`,
        [job.id, i, inputHash],
      );

      let translation: string;
      if (cached.rows[0]) {
        translation = cached.rows[0].output;
        origin = origin === "provider" ? "provider" : "cache";
      } else {
        const result = await providers.translate(chunk, { sourceLang: row.language });
        const parsed = parseTranslatePayload(result.raw) ?? {
          translation: result.translation,
          detected_language: result.detectedLanguage,
        };
        translation = stripOutputBidi(parsed.translation);
        detectedLang = parsed.detected_language || result.detectedLanguage || detectedLang;
        model = result.model;
        modelReported = result.modelReported;
        if (result.origin === "provider") origin = "provider";
        else if (origin !== "provider" && origin !== "cache") origin = "mock";

        totalIn += result.usage.inputTokens ?? estimateTokens(chunk);
        totalOut += result.usage.outputTokens ?? estimateTokens(translation);

        const v = validateTranslationOutput(chunk, translation, {
          sourceLang: row.language,
          detectedLanguage: parsed.detected_language,
          ratioCjk: config.translation.ratioCjk,
          ratioOther: config.translation.ratioOther,
          sourceHadInjection,
        });
        if (!v.ok) {
          const err = new Error(v.reason);
          (err as Error & { code: string }).code = "invalid_output";
          throw err;
        }
        for (const f of v.flags) flags.add(f);

        const c = await pool.connect();
        try {
          await c.query(
            `INSERT INTO translation_chunk_cache (job_id, chunk_idx, input_hash, output)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (job_id, chunk_idx) DO UPDATE SET output = EXCLUDED.output, input_hash = EXCLUDED.input_hash`,
            [job.id, i, inputHash, translation],
          );
        } finally {
          c.release();
        }
      }
      outputs.push(translation);
    }

    const joined = outputs.join("\n\n");
    const whole = validateTranslationOutput(
      [row.headline, row.body].filter(Boolean).join("\n\n"),
      joined,
      {
        sourceLang: row.language,
        detectedLanguage: detectedLang,
        ratioCjk: config.translation.ratioCjk,
        ratioOther: config.translation.ratioOther,
        expectedParagraphs: chunked.inputParagraphCount,
        sourceHadInjection,
      },
    );
    if (!whole.ok) {
      const err = new Error(whole.reason);
      (err as Error & { code: string }).code = "invalid_output";
      throw err;
    }
    for (const f of whole.flags) flags.add(f);

    // Split joined back into headline vs body when original had a headline
    let headlineEn: string | null = null;
    let bodyEn: string | null = null;
    if (row.headline?.trim()) {
      const paras = joined.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      headlineEn = paras[0] ?? null;
      bodyEn = paras.length > 1 ? paras.slice(1).join("\n\n") : null;
    } else {
      bodyEn = joined;
    }
    if (!headlineEn && !bodyEn) {
      const err = new Error("out_empty");
      (err as Error & { code: string }).code = "invalid_output";
      throw err;
    }

    const costMicro =
      origin === "mock" || origin === "cache"
        ? 0
        : estimateCostMicro(totalIn, totalOut, priceIn, priceOut);

    const inputHash = hashInput(joined, promptVersion);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const ok = await finishTranslation(c, {
        jobId: job.id,
        articleId: job.articleId,
        articleVersion: job.articleVersion,
        workerId,
        promptVersion,
        inputHash,
        truncated: false,
        trust,
        reservedMicro: reserveMicro,
        providerBudgetKey: providerKey,
        dayUtc,
        headlineEn,
        bodyEn,
        sourceLang: row.language,
        detectedLang,
        chunkCount: chunked.chunks.length,
        flags: [...flags],
        costMicro,
        model,
        modelReported: modelReported ?? null,
        origin,
        usage: { inputTokens: totalIn, outputTokens: totalOut },
      });
      if (!ok) {
        await c.query("COMMIT");
        return;
      }
      await c.query("COMMIT");
      breaker.onSuccess();
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    await pool.query(`SELECT worker_set_flag($1, $2)`, [
      `breaker.${breaker.name}`,
      breaker.snapshot(),
    ]);
  } catch (err) {
    await recordFailure({
      pool,
      clock,
      breaker,
      providerKey,
      dayUtc,
      reserveMicro,
      workerId,
      job,
      config,
      err,
    });
  }
}

async function markJobSuperseded(pool: pg.Pool, jobId: string, workerId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `UPDATE enrichment_jobs
          SET state = 'superseded_version', reason_code = 'new_version',
              claimed_by = NULL, claim_expires_at = NULL, reserved_micro = 0, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND state = 'running'`,
      [jobId, workerId],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function markJobDead(
  pool: pg.Pool,
  jobId: string,
  workerId: string,
  reason: string,
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      `UPDATE enrichment_jobs
          SET state = 'dead', reason_code = $3, last_error = $3,
              claimed_by = NULL, claim_expires_at = NULL, reserved_micro = 0, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND state = 'running'`,
      [jobId, workerId, reason],
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function reserveOrDefer(opts: {
  pool: pg.Pool;
  config: AppConfig;
  providerKey: string;
  dayUtc: string;
  reserveMicro: number;
  jobId: string;
  workerId: string;
}): Promise<boolean> {
  const { pool, config, providerKey, dayUtc, reserveMicro, jobId, workerId } = opts;
  const capDollars =
    providerKey === "jev"
      ? config.budget.jevDaily
      : providerKey === "openai-translate"
        ? config.budget.translateDaily
        : config.budget.openaiDaily;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureBudgetDay(
      client,
      providerKey,
      dayUtc,
      config.budget.currency,
      dollarsToMicro(capDollars),
    );
    const remaining = await reserveBudget(client, providerKey, dayUtc, reserveMicro);
    if (remaining === null) {
      await client.query(
        `UPDATE enrichment_jobs
            SET state = 'deferred_budget', reason_code = 'budget_exhausted',
                next_attempt_at = (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC',
                claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND claimed_by = $2`,
        [jobId, workerId],
      );
      await client.query("COMMIT");
      return false;
    }
    await client.query(`UPDATE enrichment_jobs SET reserved_micro = $2 WHERE id = $1`, [
      jobId,
      reserveMicro,
    ]);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function callProvider(opts: {
  job: { part: "sentiment" | "summary_topics" };
  providers: EnrichmentProviders;
  config: AppConfig;
  text: string;
  headline: string | null;
}): Promise<{
  costMicro: number;
  result:
    | Awaited<ReturnType<EnrichmentProviders["classifySentiment"]>>
    | Awaited<ReturnType<EnrichmentProviders["summariseAndTag"]>>;
}> {
  const { job, providers, config, text, headline } = opts;
  if (job.part === "sentiment") {
    const result = await providers.classifySentiment(text, headline);
    const priceIn = config.jev.priceInPerMtok ?? 0;
    const priceOut = config.jev.priceOutPerMtok ?? 0;
    const costMicro =
      result.origin === "mock"
        ? 0
        : estimateCostMicro(
            result.usage.inputTokens ?? 0,
            result.usage.outputTokens ?? 0,
            priceIn,
            priceOut,
          );
    return { costMicro, result };
  }
  const result = await providers.summariseAndTag(text, headline);
  const priceIn = config.openai.priceInPerMtok ?? 0;
  const priceOut = config.openai.priceOutPerMtok ?? 0;
  const costMicro =
    result.origin === "mock"
      ? 0
      : estimateCostMicro(
          result.usage.inputTokens ?? 0,
          result.usage.outputTokens ?? 0,
          priceIn,
          priceOut,
        );
  return { costMicro, result };
}

async function recordFailure(opts: {
  pool: pg.Pool;
  clock: Clock;
  breaker: CircuitBreaker;
  providerKey: string;
  dayUtc: string;
  reserveMicro: number;
  workerId: string;
  job: { id: string; attempts: number };
  config: AppConfig;
  err: unknown;
}): Promise<void> {
  const { pool, clock, breaker, providerKey, dayUtc, reserveMicro, workerId, job, config, err } =
    opts;
  breaker.onFailure(clock.now().getTime());
  const cls = classifyProviderError(err);
  const maxA = maxAttemptsFor(cls, config.maxAttempts);
  const lastError = formatLastError(err);
  const reasonFromErr =
    err instanceof Error && typeof (err as Error & { code?: string }).code === "string"
      ? (err as Error & { code: string }).code
      : err instanceof Error
        ? err.message
        : null;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (reserveMicro > 0) {
      await releaseBudget(c, providerKey, dayUtc, reserveMicro);
    }
    if (job.attempts >= maxA || cls === "permanent") {
      await c.query(
        `UPDATE enrichment_jobs
            SET state = 'dead', reason_code = $3, last_error = $4,
                reserved_micro = 0, claimed_by = NULL, claim_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND claimed_by = $2`,
        [
          job.id,
          workerId,
          reasonFromErr && reasonFromErr !== "invalid_output"
            ? reasonFromErr
            : cls === "invalid_output"
              ? "invalid_output"
              : "permanent_failure",
          lastError,
        ],
      );
    } else {
      const delay = nextDelayMs(job.attempts, clock);
      await c.query(
        `UPDATE enrichment_jobs
            SET state = 'failed_retryable',
                invalid_attempts = invalid_attempts + CASE WHEN $5 THEN 1 ELSE 0 END,
                next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                reserved_micro = 0, claimed_by = NULL, claim_expires_at = NULL,
                last_error = $4, updated_at = now()
          WHERE id = $1 AND claimed_by = $2`,
        [job.id, workerId, String(delay), lastError, cls === "invalid_output"],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    log.error({ err: e }, "failure handling failed");
  } finally {
    c.release();
  }
  await pool.query(`SELECT worker_set_flag($1, $2)`, [
    `breaker.${breaker.name}`,
    breaker.snapshot(),
  ]);
}
