import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadConfig, type AppConfig } from "../config";
import { createPool } from "../db/pool";
import { buildSearchText, contentHash, NORMALISER_VERSION } from "../normalise";
import { reduceMarkup, SANITISER_VERSION } from "../sanitise/reduce";
import { validateArticle } from "../validate/article";
import { needsTranslation } from "../translate/language";
import { log } from "../log";

export type IngestItemResult = {
  position: number;
  outcome: "admitted" | "quarantined" | "duplicate";
  reasonCodes: string[];
  articleId: string | null;
  articleVersion: number | null;
  externalId?: string | null;
  source?: string | null;
};

export type LoadResult = {
  received: number;
  admitted: number;
  quarantined: number;
  duplicate: number;
  /** Overlap with quarantined for CLI compatibility only; not used in reconciliation. */
  errors: number;
  versions: number;
  batchId: string;
  items: IngestItemResult[];
  reconciled: boolean;
};

export async function loadArticlesFile(
  filePath: string,
  batchKind: "live" | "backfill" = "backfill",
): Promise<LoadResult> {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("sample file must be a JSON array");
  return loadArticles(raw, batchKind);
}

export async function loadArticles(
  items: unknown[],
  batchKind: "live" | "backfill" = "backfill",
  pool?: pg.Pool,
  config?: AppConfig,
): Promise<LoadResult> {
  const cfg = config ?? loadConfig({ ...process.env, ROLE: process.env.ROLE ?? "seed" });
  const owned = !pool;
  const db = pool ?? createPool(cfg.db, "ingest");

  const batchId = randomUUID();
  let admitted = 0;
  let quarantined = 0;
  let duplicate = 0;
  let errors = 0;
  let versions = 0;
  const itemResults: IngestItemResult[] = [];

  try {
    for (let position = 0; position < items.length; position++) {
      const item = items[position];
      try {
        const one = await ingestOne(
          db,
          item,
          batchId,
          batchKind,
          position,
          cfg.promptVersion,
          cfg.translation.promptVersion,
        );
        const itemResult: IngestItemResult = {
          position,
          outcome: one.outcome === "error" ? "quarantined" : one.outcome,
          reasonCodes: one.reasonCodes,
          articleId: one.articleId,
          articleVersion: one.articleVersion,
        };
        if (one.externalId !== undefined) itemResult.externalId = one.externalId;
        if (one.source !== undefined) itemResult.source = one.source;
        itemResults.push(itemResult);
        if (one.outcome === "admitted") {
          admitted++;
          if (one.reasonCodes.includes("new_version")) versions++;
        } else if (one.outcome === "quarantined") {
          quarantined++;
        } else if (one.outcome === "error") {
          quarantined++;
          errors++;
        } else {
          duplicate++;
        }
      } catch (e) {
        if (isConnectionError(e)) throw e;
        log.error({ err: e, position }, "ingest item failed unexpectedly");
        const recorded = await recordItemError(db, item, batchId, batchKind, position, e);
        if (recorded) {
          quarantined++;
          errors++;
          itemResults.push({
            position,
            outcome: "quarantined",
            reasonCodes: ["ingest_error"],
            articleId: null,
            articleVersion: null,
          });
        } else {
          throw e;
        }
      }
    }
  } finally {
    if (owned) await db.end();
  }

  const reconciled = items.length === admitted + duplicate + quarantined;
  return {
    received: items.length,
    admitted,
    quarantined,
    duplicate,
    errors,
    versions,
    batchId,
    items: itemResults,
    reconciled,
  };
}

function isConnectionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "57P01") return true;
  if (err.code === "57P03" || err.code === "08006" || err.code === "08003") return true;
  const msg = (err.message ?? "").toLowerCase();
  return (
    msg.includes("connection terminated") ||
    msg.includes("connection refused") ||
    msg.includes("cannot use a pool after calling end") ||
    msg.includes("client was closed")
  );
}

/** Strip NULs and unpaired UTF-16 surrogates. */
export function repairText(input: string | null): string | null {
  if (input === null) return null;
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += input[i]! + input[i + 1]!;
        i++;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // drop lone low surrogate
    } else {
      out += input[i]!;
    }
  }
  return out;
}

async function quarantine(
  client: pg.PoolClient,
  opts: {
    batchId: string;
    batchKind: "live" | "backfill";
    position: number;
    payloadSha: Buffer;
    byteSize: number;
    reasonCodes: string[];
    fieldErrors?: unknown;
    payload: string;
  },
): Promise<void> {
  const ev = await client.query<{ id: string }>(
    `INSERT INTO ingest_events (batch_id, batch_kind, position, payload_sha256, byte_size, outcome, reason_codes)
     VALUES ($1::uuid, $2, $3, $4, $5, 'quarantined', $6)
     RETURNING id`,
    [
      opts.batchId,
      opts.batchKind,
      opts.position,
      opts.payloadSha,
      opts.byteSize,
      opts.reasonCodes,
    ],
  );
  await client.query(
    `INSERT INTO ingest_quarantine (event_id, reason_codes, field_errors, payload_text)
     VALUES ($1, $2, $3, $4)`,
    [
      ev.rows[0]!.id,
      opts.reasonCodes,
      opts.fieldErrors ?? null,
      opts.payload.slice(0, 1_048_576),
    ],
  );
}

async function recordItemError(
  db: pg.Pool,
  item: unknown,
  batchId: string,
  batchKind: "live" | "backfill",
  position: number,
  err: unknown,
): Promise<boolean> {
  const payload = (() => {
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  })();
  const payloadSha = createHash("sha256").update(payload).digest();
  const byteSize = Buffer.byteLength(payload, "utf8");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await quarantine(client, {
      batchId,
      batchKind,
      position,
      payloadSha,
      byteSize,
      reasonCodes: ["ingest_error"],
      fieldErrors: { message: err instanceof Error ? err.message.slice(0, 500) : String(err) },
      payload,
    });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isConnectionError(e)) throw e;
    return false;
  } finally {
    client.release();
  }
}

type IngestOneResult = {
  outcome: "admitted" | "quarantined" | "duplicate" | "error";
  reasonCodes: string[];
  articleId: string | null;
  articleVersion: number | null;
  externalId?: string | null;
  source?: string | null;
};

async function ingestOne(
  db: pg.Pool,
  item: unknown,
  batchId: string,
  batchKind: "live" | "backfill",
  position: number,
  promptVersion: string,
  translatePromptVersion: string = "t1",
): Promise<IngestOneResult> {
  const payload = JSON.stringify(item);
  const payloadSha = createHash("sha256").update(payload).digest();
  const byteSize = Buffer.byteLength(payload, "utf8");

  const validated = validateArticle(item);
  if (!validated.ok) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await quarantine(client, {
        batchId,
        batchKind,
        position,
        payloadSha,
        byteSize,
        reasonCodes: validated.reasonCodes,
        fieldErrors: validated.fieldErrors,
        payload,
      });
      await client.query("COMMIT");
      return {
        outcome: "quarantined",
        reasonCodes: validated.reasonCodes,
        articleId: null,
        articleVersion: null,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  const v = validated.value;
  const headReduced = reduceMarkup(v.headline);
  const bodyReduced = reduceMarkup(v.body);
  const headline = repairText(headReduced.text);
  const body = repairText(bodyReduced.text);

  if (headline === null && body === null) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await quarantine(client, {
        batchId,
        batchKind,
        position,
        payloadSha,
        byteSize,
        reasonCodes: ["no_text"],
        payload,
      });
      await client.query("COMMIT");
      return {
        outcome: "quarantined",
        reasonCodes: ["no_text"],
        articleId: null,
        articleVersion: null,
        externalId: v.externalId,
        source: v.source,
      };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  const flags = new Set(v.flags);
  if (headReduced.transformations.length || bodyReduced.transformations.length) {
    flags.add("markup_removed");
  }
  if (v.headline === null || flags.has("headline_missing") || flags.has("headline_placeholder")) {
    flags.add("headline_absent");
  }

  const searchText = buildSearchText(headline, body);
  const hash = contentHash(headline, body);

  const transformations: unknown[] = [];
  for (const field of ["headline", "body"] as const) {
    const transforms =
      field === "headline" ? headReduced.transformations : bodyReduced.transformations;
    for (const t of transforms) {
      transformations.push({
        field,
        kind: t.kind,
        detail: { counts: t.counts, removedHashes: t.removedHashes },
        tool: "htmlparser2-reduce",
        tool_version: SANITISER_VERSION,
      });
    }
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const dupContent = await client.query<{ id: string }>(
      `SELECT id FROM articles WHERE content_hash = $1 LIMIT 1`,
      [hash],
    );
    if (dupContent.rows[0]) flags.add("duplicate_content");

    const inserted = await client.query<{ id: string; version: number }>(
      `INSERT INTO articles (
         external_id, source, published_at, language, headline, body,
         content_hash, flags, search_text, search_text_ver, version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
       ON CONFLICT (source, external_id) DO NOTHING
       RETURNING id, version`,
      [
        v.externalId,
        v.source,
        v.publishedAt.toISOString(),
        v.language,
        headline,
        body,
        hash,
        [...flags],
        searchText,
        NORMALISER_VERSION,
      ],
    );

    if (!inserted.rows[0]) {
      const existing = await client.query<{ id: string; content_hash: Buffer; version: number }>(
        `SELECT id, content_hash, version FROM articles WHERE source = $1 AND external_id = $2`,
        [v.source, v.externalId],
      );
      const row = existing.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return {
          outcome: "error",
          reasonCodes: ["ingest_error"],
          articleId: null,
          articleVersion: null,
          externalId: v.externalId,
          source: v.source,
        };
      }

      const existingHash = Buffer.from(row.content_hash);
      if (existingHash.equals(hash)) {
        await client.query(
          `INSERT INTO ingest_events (
             batch_id, batch_kind, position, payload_sha256, byte_size,
             outcome, reason_codes, article_id, article_version
           ) VALUES ($1::uuid, $2, $3, $4, $5, 'duplicate', $6, $7, $8)`,
          [
            batchId,
            batchKind,
            position,
            payloadSha,
            byteSize,
            ["duplicate_id"],
            row.id,
            row.version,
          ],
        );
        await client.query("COMMIT");
        return {
          outcome: "duplicate",
          reasonCodes: ["duplicate_id"],
          articleId: row.id,
          articleVersion: row.version,
          externalId: v.externalId,
          source: v.source,
        };
      }

      const hasText = Boolean((headline ?? "").trim() || (body ?? "").trim());
      const wantTranslation = needsTranslation(v.language);
      const versioned = await client.query<{
        result: string;
        new_version: number;
        event_id: string | null;
      }>(
        `SELECT result, new_version, event_id FROM ingest_new_version(
           $1::bigint, $2::uuid, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11, $12,
           $13, $14::smallint, $15::jsonb, $16, $17, $18
         )`,
        [
          row.id,
          batchId,
          batchKind,
          position,
          payloadSha,
          byteSize,
          hash,
          v.publishedAt.toISOString(),
          v.language,
          headline,
          body,
          [...flags],
          searchText,
          NORMALISER_VERSION,
          JSON.stringify(transformations),
          promptVersion,
          hasText,
          wantTranslation,
        ],
      );
      const vr = versioned.rows[0]!;
      if (vr.result === "unchanged") {
        await client.query(
          `INSERT INTO ingest_events (
             batch_id, batch_kind, position, payload_sha256, byte_size,
             outcome, reason_codes, article_id, article_version
           ) VALUES ($1::uuid, $2, $3, $4, $5, 'duplicate', $6, $7, $8)`,
          [
            batchId,
            batchKind,
            position,
            payloadSha,
            byteSize,
            ["duplicate_id"],
            row.id,
            vr.new_version,
          ],
        );
        await client.query("COMMIT");
        return {
          outcome: "duplicate",
          reasonCodes: ["duplicate_id"],
          articleId: row.id,
          articleVersion: vr.new_version,
          externalId: v.externalId,
          source: v.source,
        };
      }
      await client.query("COMMIT");
      return {
        outcome: "admitted",
        reasonCodes: [...flags, "new_version"],
        articleId: row.id,
        articleVersion: vr.new_version,
        externalId: v.externalId,
        source: v.source,
      };
    }

    const articleId = inserted.rows[0].id;
    const articleVersion = inserted.rows[0].version ?? 1;

    await client.query(
      `INSERT INTO ingest_events (
         batch_id, batch_kind, position, payload_sha256, byte_size,
         outcome, reason_codes, article_id, article_version
       ) VALUES ($1::uuid, $2, $3, $4, $5, 'admitted', $6, $7, $8)`,
      [batchId, batchKind, position, payloadSha, byteSize, [...flags], articleId, articleVersion],
    );

    for (const t of transformations) {
      const tr = t as {
        field: string;
        kind: string;
        detail: unknown;
        tool: string;
        tool_version: string;
      };
      await client.query(
        `INSERT INTO ingest_transformations (article_id, field, kind, detail, tool, tool_version)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [articleId, tr.field, tr.kind, JSON.stringify(tr.detail), tr.tool, tr.tool_version],
      );
    }

    const hasText = Boolean((headline ?? "").trim() || (body ?? "").trim());
    const state = hasText ? "queued" : "skipped_no_content";
    const reason = hasText ? null : "no_content";
    const wantTranslation = needsTranslation(v.language);
    if (wantTranslation) {
      await client.query(
        `INSERT INTO enrichment_jobs (article_id, article_version, part, prompt_version, state, reason_code)
         VALUES
           ($1, $2, 'sentiment', $3, $4, $5),
           ($1, $2, 'summary_topics', $3, $4, $5),
           ($1, $2, 'translation', $6, $4, $5)`,
        [articleId, articleVersion, promptVersion, state, reason, translatePromptVersion],
      );
    } else {
      await client.query(
        `INSERT INTO enrichment_jobs (article_id, article_version, part, prompt_version, state, reason_code)
         VALUES
           ($1, $2, 'sentiment', $3, $4, $5),
           ($1, $2, 'summary_topics', $3, $4, $5)`,
        [articleId, articleVersion, promptVersion, state, reason],
      );
    }

    await client.query("COMMIT");
    return {
      outcome: "admitted",
      reasonCodes: [...flags],
      articleId,
      articleVersion,
      externalId: v.externalId,
      source: v.source,
    };
  } catch (e) {
    await client.query("ROLLBACK");
    log.error({ err: e, position }, "ingest item failed");
    if (isConnectionError(e)) throw e;
    const recorded = await recordItemError(db, item, batchId, batchKind, position, e);
    if (recorded) {
      return {
        outcome: "error",
        reasonCodes: ["ingest_error"],
        articleId: null,
        articleVersion: null,
      };
    }
    throw e;
  } finally {
    client.release();
  }
}
