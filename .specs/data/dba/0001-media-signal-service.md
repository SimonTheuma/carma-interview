---
spec: carma-dba
number: 0001
title: PostgreSQL schema, indexes, write path and operations for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/architect/adrs/0001-assignment-scope-carma-ready.md
  - .specs/architect/adrs/0003-enrichment-providers.md
  - .specs/architect/adrs/0004-confidence-in-scope.md
  - .specs/architect/adrs/0006-extensions-core-contrib.md
  - .specs/architect/adrs/0008-topic-breakdown-multilabel.md
  - .specs/search/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
principles: [P1, P2, P3, P5, P6, P7, P8]
supersedes: null
---

# Database plan

## 1. Summary

A single PostgreSQL database, plain-SQL migrations applied automatically at start, four login roles, and a table set built for **append-mostly writes, a visible work ledger and traceable derived values**. The article row is written once and never updated. Everything that changes (jobs, budget) lives in narrow tables. The sizes are tiny at the assignment's scale (50,000 articles a day is 0.58 a second), so the design is chosen for correctness and for being an honest first step toward 800/s, not for tuning.

Three things to know up front:

1. **The trigram index is the expensive one.** For 3 KB articles a `gin_trgm_ops` index is likely larger than the text itself and is the heaviest part of every insert. It is justified at 20 rows by the Chinese and Arabic requirement (ADR-0007) and is the first thing to change at 800/s (section 3).
2. **Whether `pg_trgm` indexes Chinese and Arabic at all depends on the database locale and image** (FP-S2). Section 11 gives a 10-minute check. Correctness never depends on it; only speed does.
3. **No decisions block this spec.** Defaults are recorded in section 14.

## 2. Inputs and current database state

- Greenfield: no schema, no migrations, no database (architect spec section 3).
- PostgreSQL version: unknown. The plan assumes a currently supported major version (16 or newer) from the official Debian-based image, with the major pinned in Compose. Confirm at build (`UNCONFIRMED`).
- Extensions: `pg_trgm`, `unaccent`, `pg_stat_statements` are in the standard contrib set (ADR-0006). They are not verified yet. `pg_stat_statements` needs `shared_preload_libraries` set at server start (devops).
- Sample data: 20 rows, 111 to 604 characters of body, fields all present except id 17's empty headline.

## 3. Write budget and capacity model

Assumptions (all `UNCONFIRMED`; replace with measurement):

- Average article text 3 KB (the sample is 0.4 KB, real articles are 1 to 5 KB, per the context file).
- Compression of TOASTed text about 2x.
- Peak of 10 times the average for the assignment case.

| Quantity | Assignment case (50K/day) | Growth case (800/s) |
| --- | --- | --- |
| Articles per second, average | 0.58 (peak about 6) | 800 |
| Articles per day | 50,000 | 69.1 M |
| Child rows per article (jobs 2, enrichments 2, derived values about 4, events 1, transformations about 0.3) | about 9 | about 9 |
| Child rows per second | about 5 (peak 50) | about 7,200 |
| Job-row updates per article (claim, finish, per part, about 3 each) | about 6 | about 4,800 per second |
| Heap per article (headline + body + `search_text`, compressed) | about 3 KB | same |
| `search_vector` (simple config, positions) | about 1.5 KB | same |
| FTS GIN share per article | about 1 KB | same |
| Trigram GIN share per article | about 3 to 6 KB (hypothesis) | same |
| Total per article, with indexes | about 10 to 14 KB | same |
| Per day | about 0.5 to 0.7 GB | about 700 to 970 GB |
| Per year | about 180 to 260 GB | not retainable on one host for long |

Reading the growth column: the context file's estimate was 69 to 345 GB a day of raw text before indexes. Duplicating the text into `search_text` and adding a trigram index roughly triples that, which is not affordable. Growth-path changes, in order: (1) drop the duplicate `search_text` and build the vector from an immutable SQL normaliser; (2) build the trigram index only for CJK/Arabic-script rows or only on aged partitions; (3) replace trigram with a 2-gram index extension for CJK if permitted; (4) partition by time and index the newest partition lightly (section 6). Each is a documented option, not built.

Write amplification at 800/s is dominated by the job rows, not articles: roughly 4,800 job updates a second, each creating a new row version unless HOT. That is why the jobs table has a low fill factor and aggressive autovacuum (section 10), and why the growth path considers a queue extension or a job library (architect spec 5.2).

## 4. Schema

All DDL below is an **illustrative sketch** of the design, not a final migration. Types: `timestamptz` everywhere, `bigint` identity keys, `text` for text, `CHECK` constraints for enumerations (cheap to evolve with migrations).

### 4.1 Articles (the system of record)

```sql
CREATE TABLE articles (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  external_id      text        NOT NULL,           -- the supplied id, as text
  source           text        NOT NULL,
  published_at     timestamptz NOT NULL,           -- UTC instant
  ingested_at      timestamptz NOT NULL DEFAULT now(),
  language         text        NOT NULL DEFAULT 'und',
  headline         text,                           -- NULL = absent
  body             text,                           -- NULL = absent
  content_hash     bytea       NOT NULL,           -- sha256(normalised headline + body)
  flags            text[]      NOT NULL DEFAULT '{}',
  search_text      text        NOT NULL,           -- shared normaliser output, coalesced
  search_text_ver  smallint    NOT NULL,           -- normaliser version, to find rows to rebuild
  search_vector    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  CONSTRAINT articles_has_text CHECK (headline IS NOT NULL OR body IS NOT NULL),
  CONSTRAINT articles_source_ext_uq UNIQUE (source, external_id)
);
```

- **No updates.** Nothing in the application updates `articles`. Enrichment state lives elsewhere (4.2 to 4.4).
- **Text as text.** Headline and body are the reduced text (data-sanity section 7). Raw markup is not stored. No JSONB column holds the article.
- **`search_text` is a stored column**, not generated, because the normaliser (NFKC, Arabic folding, bidi/zero-width removal) lives in application code so that index time and query time use the same function (search spec section 3). `search_text_ver` makes a normaliser change a backfill, not a mystery (P8). `coalesce` guarantees `NOT NULL`, which protects `NOT` predicates (FP-S3, FP-D6).
- **`search_vector` is generated** (`to_tsvector(regconfig, text)` is immutable, so it is allowed). It is created in the first migration, on an empty table: adding a generated column later rewrites the table.
- **Weights:** the search spec mentioned headline weight A and body weight B. With recency-only ordering (S3) weights have no use, so one unweighted vector is built. If relevance ranking is added later, add a second normalised column and rebuild; noted as an inconsistency to close in the plan.
- **Key:** `(source, external_id)` is unique. Whether `id` is unique across sources is unknown (architect open question 3), and the composite is safe either way. A surrogate `id` keeps keyset ordering and joins compact.
- **Duplicates by content:** `content_hash` is indexed, non-unique. Identical content under a different id is admitted, flagged `duplicate_content`, and reuses cached enrichment (data-sanity section 9). Nothing is deleted (P4).

### 4.2 Enrichment ledger and results

```sql
CREATE TABLE enrichment_jobs (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id        bigint NOT NULL REFERENCES articles(id),
  part              text   NOT NULL CHECK (part IN ('sentiment','summary_topics')),
  prompt_version    text   NOT NULL,
  state             text   NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','running','succeeded','failed_retryable',
                                     'deferred_budget','skipped_no_content','dead')),
  attempts          smallint NOT NULL DEFAULT 0,
  invalid_attempts  smallint NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  claimed_by        text,
  claimed_at        timestamptz,
  claim_expires_at  timestamptz,
  reserved_micro    bigint NOT NULL DEFAULT 0,       -- budget held while running
  reason_code       text,                            -- why dead / skipped / deferred
  last_error        text,                            -- capped, scrubbed
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, part, prompt_version)
) WITH (fillfactor = 80);

CREATE TABLE enrichments (                           -- one row per successful provider result
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id       bigint NOT NULL REFERENCES articles(id),
  part             text   NOT NULL CHECK (part IN ('sentiment','summary_topics')),
  provider         text   NOT NULL,                  -- 'jev', 'openai', 'mock'
  model            text   NOT NULL,                  -- requested id
  model_reported   text,                             -- id/version the provider says it ran
  prompt_version   text   NOT NULL,
  origin           text   NOT NULL CHECK (origin IN ('provider','cache','mock')),
  input_hash       bytea  NOT NULL,                  -- cache key
  input_truncated  boolean NOT NULL DEFAULT false,
  input_tokens     integer, output_tokens integer, cost_micro bigint,
  trust            text   NOT NULL DEFAULT 'normal' CHECK (trust IN ('normal','low')),
  raw_output       jsonb,                            -- write-once, capped, never queried
  job_id           bigint REFERENCES enrichment_jobs(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz
);
CREATE UNIQUE INDEX enrichments_current_uq ON enrichments (article_id, part) WHERE superseded_at IS NULL;

CREATE TABLE derived_values (                        -- one row per derived value, with confidence
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrichment_id     bigint NOT NULL REFERENCES enrichments(id),
  article_id        bigint NOT NULL REFERENCES articles(id),   -- denormalised for indexes
  field             text   NOT NULL CHECK (field IN ('sentiment','summary','topic')),
  value             text   NOT NULL,
  rank              smallint,                                   -- topic order 1..3
  vocab_version     smallint,                                   -- topics
  confidence_norm   numeric(5,2) CHECK (confidence_norm BETWEEN 0 AND 100),
  confidence_raw    double precision,
  scale_min         double precision, scale_max double precision,
  confidence_origin text   NOT NULL CHECK (confidence_origin IN
                      ('classifier_concentration','llm_self_report','none','mock','human')),
  method            text   NOT NULL,                            -- e.g. 'jev:choice', 'openai:structured'
  extra             jsonb,                                      -- e.g. jev class probabilities
  is_current        boolean NOT NULL DEFAULT true,
  CONSTRAINT dv_conf_complete CHECK (
    (confidence_norm IS NULL AND confidence_origin = 'none')
    OR (confidence_norm IS NOT NULL AND confidence_raw IS NOT NULL
        AND scale_min IS NOT NULL AND scale_max IS NOT NULL AND scale_min < scale_max))
);
```

Justifications:

- **Generic `derived_values` rather than one table per field.** There are three fields, all read together for display and filtered by value. A single narrow table gives one confidence structure (P6, P7) and one index pattern. Per-field tables would triplicate the confidence columns.
- **The constraint `dv_conf_complete`** is the null rule from data-sanity: confidence is either fully described (value, raw, range with min < max, origin) or explicitly absent with origin `none`. A bare 0 or a missing range cannot be stored.
- **`mock` origin** is representable, so mock output cannot pass as model output (FP-17).
- **Append-mostly:** results are inserted once. Re-enrichment inserts new rows and, in one transaction, sets `superseded_at` on the old enrichment and `is_current = false` on its values. These are the only updates on these tables and they are rare.
- **Where each principle lives:** P6 `confidence_*`; P7 `confidence_origin`, `method`, `scale_*`, `model_reported`, `prompt_version`, `raw_output`; P8 `article_id`, `input_hash`, `input_truncated`, `job_id`.
- **Sentiment `extra`** holds jev's per-class probabilities (data-sanity validates they sum to 1).

### 4.3 Budget and flags

```sql
CREATE TABLE llm_budget_ledger (
  provider       text   NOT NULL,
  day_utc        date   NOT NULL,
  currency       text   NOT NULL,
  cap_micro      bigint NOT NULL,
  reserved_micro bigint NOT NULL DEFAULT 0,
  spent_micro    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day_utc),
  CHECK (reserved_micro >= 0 AND spent_micro >= 0)
);
CREATE TABLE system_flags (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
```

Atomic reservation (one statement; zero rows returned means the budget is exhausted and the job becomes `deferred_budget`):

```sql
UPDATE llm_budget_ledger
   SET reserved_micro = reserved_micro + $3
 WHERE provider = $1 AND day_utc = $2
   AND reserved_micro + spent_micro + $3 <= cap_micro
RETURNING cap_micro - reserved_micro - spent_micro AS remaining_micro;
```

The row for today is created with `INSERT ... ON CONFLICT DO NOTHING` (cap from configuration) before the first reservation. After the call, `UPDATE ... SET reserved_micro = reserved_micro - $res, spent_micro = spent_micro + $actual`. On failure or sweeper expiry, release: `reserved_micro = reserved_micro - $res`. The job row's `reserved_micro` is the source for a release. `system_flags` holds `enrichment_enabled` and a `capabilities` entry (for example `trgm_index=on|off`) written by the migrator so the search compiler knows what was installed.

### 4.4 Ingest ledger, quarantine, transformations

```sql
CREATE TABLE ingest_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id       uuid   NOT NULL,
  batch_kind     text   NOT NULL DEFAULT 'backfill' CHECK (batch_kind IN ('live','backfill')),  -- freshness SLI excludes backfill
  position       integer NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  payload_sha256 bytea  NOT NULL,
  byte_size      integer NOT NULL,
  outcome        text   NOT NULL CHECK (outcome IN ('admitted','quarantined','duplicate')),
  reason_codes   text[] NOT NULL DEFAULT '{}',
  article_id     bigint REFERENCES articles(id)
);
CREATE TABLE ingest_quarantine (
  event_id   bigint PRIMARY KEY REFERENCES ingest_events(id),
  reason_codes text[] NOT NULL,
  field_errors jsonb,                  -- diagnostics, write-once, not queried
  payload_text text,                   -- exact received item, capped; NULLed after retention
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','replayed','discarded')),
  resolved_at timestamptz, note text, replayed_article_id bigint REFERENCES articles(id)
);
CREATE TABLE ingest_transformations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id bigint NOT NULL REFERENCES articles(id),
  field text NOT NULL, kind text NOT NULL,
  detail jsonb, tool text NOT NULL, tool_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

`payload_text` is `text`, not JSONB: it must preserve the exact received bytes for replay, and a quarantined payload may not even be valid JSON. It is retained only for quarantined items (default DS1) and is not readable by `app_read`.

### 4.5 JSONB use

| Column | Why JSONB | Queried? | Written | Index |
| --- | --- | --- | --- | --- |
| `enrichments.raw_output` | Provider-shaped, varies by provider | No (inspection only) | Once, capped at about 8 KB | None |
| `derived_values.extra` | jev class probabilities | Displayed on detail, not filtered | Once | None |
| `ingest_quarantine.field_errors` | Per-field diagnostic detail | No | Once | None |
| `ingest_transformations.detail` | Counts and hashes | No | Once | None |

Everything that is filtered, sorted, joined or aggregated is a typed column. No JSONB column holds article text. No GIN index on any JSONB. Normalisation by JSONB is acceptable for all four because they are diagnostics. No JSONB layout benchmark is needed.

### 4.6 Roles and grants

Created by the migrator (first migration), passwords supplied from environment through a function `set_role_password(role, password)` that runs `ALTER ROLE ... PASSWORD` via `format('%I', ...)`/`format('%L', ...)`, so no password is in a migration file.

| Role | Grants |
| --- | --- |
| Bootstrap superuser (Compose `POSTGRES_USER`) | Used only by the migrator at start; owns all objects |
| `app_ingest` | `INSERT` on `articles`, `ingest_*`, `enrichment_jobs`; `SELECT` on `articles` (dedupe check) and `ingest_events`; USAGE on sequences; no access to `enrichments` writes |
| `app_worker` | `SELECT` on `articles`; `SELECT, UPDATE` on `enrichment_jobs`; `INSERT, UPDATE(superseded_at/is_current)` on `enrichments`, `derived_values`; `SELECT, INSERT, UPDATE` on `llm_budget_ledger`; `SELECT` on `system_flags`, plus `INSERT, UPDATE` on `system_flags` for keys prefixed `worker.` and `breaker.` only (row-level policy or a small `SECURITY DEFINER` function; heartbeat and breaker state for the status page, per telemetry spec) |
| `app_read` | `SELECT` on `articles`, `enrichments`, `derived_values`, `enrichment_jobs`, `ingest_transformations`, `llm_budget_ledger` (status), `system_flags`; **no** access to `ingest_quarantine`/`ingest_events`; `ALTER ROLE app_read SET statement_timeout = '2s'` |

Provider keys are a worker-container concern only; no database role holds them.

## 5. Extension plan

| Extension | Purpose | Principle | Cost | Burden | Availability check | Core fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pg_trgm` | Substring leaves for Chinese/Arabic (ADR-0007) | P3, P5 | Large GIN index, heavy insert cost | Low | `SELECT * FROM pg_available_extensions WHERE name='pg_trgm'`, plus the locale check in section 11 | Unindexed `ILIKE`; correct, slow at scale. Migrator records `trgm_index=off` |
| `unaccent` | Accent folding | P5 | None (`STABLE`, cannot be used in a generated column) | Low | Same | Not required; the app normaliser handles scripts. Installed but unused unless an immutable wrapper is added |
| `pg_stat_statements` | Find hot queries | P2 | Small | Needs `shared_preload_libraries` | Present in the image; preload setting is in devops | Query timing logged in the app |
| Queue (pgmq), vectors, CJK engines | Not adopted | n/a | n/a | n/a | n/a | `SKIP LOCKED` table (adopted) |

Package chosen by the user: core + contrib (ADR-0006).

## 6. Partitioning and retention

**Now:** no partitioning (ADR-0001). Retention: articles and ledgers are kept; quarantined `payload_text` is NULLed after 30 days by a documented CLI (no `pg_cron`; default DS1); `enrichments.raw_output` is kept.

**Growth path (documented in the README, not built).** Range-partition `articles` on `published_at`, monthly then daily. Costs that must be planned, because they are the real price of the door ADR-0001 left closed:

1. A partitioned table's primary key and every unique index must include the partition key. So `PRIMARY KEY (published_at, id)`, and the `(source, external_id)` uniqueness can no longer be a table constraint. It moves to a small unpartitioned `article_keys(source, external_id) PRIMARY KEY, article_id, published_at` table written in the same transaction.
2. Foreign keys from child tables must reference `(article_id, published_at)`, so children carry `published_at` (a backfill), or the foreign keys are dropped in favour of checked reconciliation.
3. Migration steps: create the partitioned table and `article_keys`; add `published_at` to children; copy by month in batches; verify counts and hashes; swap names in one transaction; keep the old table until verified; rollback is renaming back.
4. Someone must create future partitions ahead of time (application at start and a sweeper that keeps two ahead; or `pg_partman` if permitted), so a missing partition cannot stall ingestion.
5. Newest partition carries only the keyset and FTS indexes; the trigram index is built concurrently when the partition ages.

## 7. Index inventory

| Index | Type | Columns | Serves | Write cost | Verified by |
| --- | --- | --- | --- | --- | --- |
| `articles_pkey` | B-tree | `id` | Joins, detail view | Low | Constraint |
| `articles_source_ext_uq` | B-tree unique | `(source, external_id)` | Idempotent ingest | Low | Duplicate-ingest test |
| `articles_keyset_idx` | B-tree | `(published_at DESC, id DESC)` | List order, date range, keyset | Low | HP-DB3 plan |
| `articles_source_keyset_idx` | B-tree | `(source, published_at DESC, id DESC)` | Source filter + keyset | Low | Plan; low selectivity on sample (20 distinct sources) |
| `articles_lang_keyset_idx` | B-tree | `(language, published_at DESC, id DESC)` | Language filter + keyset | Low | Plan |
| `articles_fts_idx` | GIN | `search_vector` | FTS leaves | Medium | `EXPLAIN` G1, G3 |
| `articles_trgm_idx` | GIN | `search_text gin_trgm_ops` | Substring leaves | **High** | Section 11 checks |
| `articles_hash_idx` | B-tree | `content_hash` | Duplicate-content flag, cache lookup | Low | Duplicate test |
| `jobs_claim_idx` | Partial B-tree | `(part, next_attempt_at, id) WHERE state IN ('queued','failed_retryable','deferred_budget')` | Worker claim | Medium (churn) | Claim plan, race test |
| `jobs_running_idx` | Partial B-tree | `(claim_expires_at) WHERE state = 'running'` | Sweeper | Low | Sweeper test |
| `jobs_article_idx` | B-tree | `(article_id, part)` | Result-page state lookup (batch, no N+1) | Low | Plan |
| `enrichments_current_uq` | Partial unique | `(article_id, part) WHERE superseded_at IS NULL` | One current result; stale-worker guard | Low | Race test |
| `dv_article_idx` | B-tree | `(article_id) WHERE is_current` | Batch fetch for result pages | Low | Plan |
| `dv_sentiment_idx` | Partial B-tree | `(value, article_id) WHERE field='sentiment' AND is_current` | Sentiment filter, `group_by=sentiment` | Low | Plan |
| `dv_topic_idx` | Partial B-tree | `(value, article_id) WHERE field='topic' AND is_current` | Topic filter, `group_by=topic` | Low | Plan |
| `events_batch_idx` | B-tree | `(batch_id, position)` | Reconciliation | Low | Ledger query |
| `events_hash_idx` | B-tree | `(payload_sha256)` | Re-delivery detection | Low | Duplicate test |
| `transf_article_idx` | B-tree | `(article_id)` | Detail view | Low | Plan |

Index builds in the first migration run on empty tables inside the migration transaction. Later migrations on populated tables use `CREATE INDEX CONCURRENTLY` in a migration marked non-transactional.

## 8. Write path design

- **Ingestion** (loader): per item, one transaction: insert `articles`, `ingest_events` (`admitted`), `ingest_transformations`, and one `enrichment_jobs` row per part (state `queued`, or `skipped_no_content`). Transactional enqueue: no article without jobs, no jobs without an article (FP-9 family). Items are batched (for example 100 per transaction) with `unnest()` arrays; if a batch fails, it is retried row by row so only the failing row is quarantined (data-sanity rule 4).
- **Idempotency:** `INSERT ... ON CONFLICT (source, external_id) DO NOTHING RETURNING id`; no row returned means a duplicate, recorded as an `ingest_events` `duplicate` row linked to the existing article.
- **Claim** (worker):

```sql
WITH c AS (
  SELECT id FROM enrichment_jobs
   WHERE part = $1 AND state IN ('queued','failed_retryable','deferred_budget')
     AND next_attempt_at <= now()
   ORDER BY next_attempt_at, id
   LIMIT $2
   FOR UPDATE SKIP LOCKED)
UPDATE enrichment_jobs j
   SET state = 'running', claimed_by = $3, claimed_at = now(),
       claim_expires_at = now() + $4::interval, attempts = attempts + 1, updated_at = now()
  FROM c WHERE j.id = c.id
RETURNING j.id, j.article_id, j.attempts;
```

  Visibility timeout `$4` must exceed the provider per-attempt timeout plus write time (proposed 3 minutes with a 30 s call timeout). The sweeper returns expired `running` rows to `failed_retryable` and releases `reserved_micro`.
- **Finish:** one transaction: insert `enrichments` and `derived_values`, settle the budget, then `UPDATE enrichment_jobs SET state='succeeded' ... WHERE id=$1 AND claimed_by=$2 AND state='running'` and check one row was updated. A stale worker (reclaimed after timeout) fails the unique index `enrichments_current_uq` or the state check, treats it as a duplicate, and releases nothing twice.
- **Durability:** defaults kept (`fsync=on`, `synchronous_commit=on`). At 0.58 articles a second there is no reason to relax them. Relaxing `synchronous_commit` raises throughput at the cost of losing the last few commits on a crash; it is a growth-path decision to put to the user with the exact exposure window. No unlogged tables: nothing here is replayable without loss.
- **Pools:** API 10 connections (`app_read`), worker 4 per provider plus 2, loader 2; `max_connections = 50`. Direct connections (no external pooler), so prepared statements work normally.

## 9. Search read path and isolation

Shapes (parameters shown as `$n`; the search predicate is the compiler output from the search spec):

**List page (keyset):**

```sql
SELECT a.id, a.external_id, a.source, a.language, a.published_at,
       a.headline, left(a.body, 600) AS body_excerpt, a.flags
  FROM articles a
 WHERE <search predicate>                                  -- bound parameters only
   AND a.published_at >= $1 AND a.published_at < $2
   AND a.source   = ANY($3::text[])  AND a.language = ANY($4::text[])
   AND EXISTS (SELECT 1 FROM derived_values d WHERE d.article_id = a.id
               AND d.field='sentiment' AND d.is_current AND d.value = ANY($5::text[]))
   AND (a.published_at, a.id) < ($6, $7)                    -- omitted on page 1
 ORDER BY a.published_at DESC, a.id DESC
 LIMIT $8 + 1;
```

Then two batch queries for the page's ids (no N+1): `derived_values WHERE article_id = ANY($ids) AND is_current`, and `enrichment_jobs WHERE article_id = ANY($ids)` (for the "not yet enriched" state).

Expected plan: with no text filter, an `Index Scan` on `articles_keyset_idx`, no `Sort` node, at page 1 and at page 10,000 with the same cost (the row-wise comparison is an index condition). With a selective text filter the planner may choose `Bitmap Heap Scan` over the GIN index and a top-N sort; both are acceptable. A mixed predicate (`FTS OR substring`) should show a `BitmapOr` of two bitmap index scans; if it shows a sequential scan at 1 M rows, the mixed leaf is the finding (HP-DB2). On the 20-row sample every plan will be a sequential scan; plan checks need the synthetic table (section 11).

**Aggregate (weekly; the monthly variant is a second constant statement):**

```sql
WITH f AS (SELECT a.id, a.published_at FROM articles a WHERE <same filters, no keyset>),
bounds AS (SELECT COALESCE($1::timestamptz, min(published_at)) AS lo,
                  COALESCE($2::timestamptz, max(published_at) + interval '1 microsecond') AS hi FROM f),
series AS (SELECT g AS bucket_start
             FROM bounds,
                  generate_series(date_trunc('week', lo AT TIME ZONE 'UTC'),
                                  date_trunc('week', (hi - interval '1 microsecond') AT TIME ZONE 'UTC'),
                                  interval '1 week') g)
SELECT s.bucket_start, count(f.id) AS n
  FROM series s
  LEFT JOIN f ON date_trunc('week', f.published_at AT TIME ZONE 'UTC') = s.bucket_start
 GROUP BY s.bucket_start ORDER BY s.bucket_start;
```

`AT TIME ZONE 'UTC'` turns the instant into a UTC wall-clock `timestamp`, so `date_trunc('week')` gives a UTC Monday. The bucket unit is not a parameter: it selects one of two constant statements. A range wider than a cap (proposed 520 buckets) is a 400. The `group_by=sentiment` form left-joins the current sentiment row (one per article, so totals still conserve) and uses `COALESCE(value, 'not_enriched')`. The `group_by=topic` form counts `count(DISTINCT a.id)` per topic and a separate total, with `multi_label = true` (ADR-0008). Expected plan: one scan of the filtered set plus a hash aggregate; at 20 rows it is trivial, at 1 M rows it is a scan of the date-ranged slice. On-demand serving is deliberate (search spec 8).

**Isolation:** a replica is not used. Search reads and the worker share the one database; the worker is rate-limited, so contention is negligible. At growth scale, a streaming replica for `app_read` is the first isolation step and its lag counts against the 15-minute freshness target.

## 10. Operations

- **Migrations:** files `db/migrations/NNNN_name.sql`, applied by the loader/migrator on every start while holding `pg_advisory_lock`. A `schema_migrations(filename, checksum, applied_at)` table makes re-runs no-ops and detects an edited applied file. Each file is one transaction unless marked `-- no-transaction`. Every file carries its rollback SQL in a comment; at this scale the practical rollback is to recreate the volume, and the README says so. The first migration creates roles, extensions (best effort for `pg_trgm`; failure sets `trgm_index=off` and continues), tables, indexes and grants. Idempotent: `CREATE ... IF NOT EXISTS` and `DO` blocks for roles.
- **Autovacuum:** default for most tables; `enrichment_jobs` gets `autovacuum_vacuum_scale_factor = 0.02`, `fillfactor = 80` for HOT updates, because it is the only high-churn table.
- **Settings for one Docker host** (hypotheses sized for an assumed 4 GB container; scale to the real host, `UNCONFIRMED`): `shared_buffers = 1GB`, `effective_cache_size = 3GB`, `work_mem = 16MB`, `maintenance_work_mem = 256MB`, `max_connections = 50`, `max_wal_size = 4GB`, `checkpoint_timeout = 15min`, `wal_compression = on`, `random_page_cost = 1.1` (SSD), `track_io_timing = on`, `shared_preload_libraries = 'pg_stat_statements'`, `log_min_duration_statement = 200ms`, `idle_in_transaction_session_timeout = 30s`. Image: the Debian-based official image, not Alpine, because `pg_trgm` classification of non-ASCII characters depends on the C library's locale handling (hypothesis in section 11).
- **Monitoring:** `pg_stat_statements`, table and index sizes (`pg_total_relation_size`), dead tuples on `enrichment_jobs`, oldest job age, connection counts.
- **Backup/restore:** nightly `pg_dump -Fc` documented, taken from the Compose volume. Point-in-time recovery (WAL archiving) is documented, not set up. Restore test: `pg_restore` into a scratch database, then run the reconciliation queries (below). A restore is only believed after they pass.
- **Reconciliation queries (also the benchmark's completeness checks):**
  - `SELECT outcome, count(*) FROM ingest_events WHERE batch_id=$1 GROUP BY 1` equals the file's item count.
  - `SELECT count(*) FROM articles` equals admitted events (plus earlier batches).
  - Every article has exactly the expected jobs: no row in `articles a LEFT JOIN enrichment_jobs` with fewer than 2 jobs.
  - `jobs` by state sums to jobs; no `running` row past `claim_expires_at`.
  - `reserved_micro` equals the sum of `reserved_micro` of `running` jobs.

## 11. Verification plan

| # | Experiment | Measures | First or later |
| --- | --- | --- | --- |
| E1 | **`pg_trgm` on non-ASCII text** (FP-S2): on the built image, `SELECT show_trgm('科技企业'), show_trgm('العقارات'), show_trgm('ab'), show_trgm('oil prices');` and `SHOW lc_ctype; SHOW server_encoding;` | If the CJK and Arabic results are empty, the index cannot serve those terms. Then record `trgm_index` semantics as "Latin only" and change the image locale (`POSTGRES_INITDB_ARGS`) or accept unindexed substring | **First, 10 minutes** |
| E2 | Load the 20 samples; run the three golden queries and G8, G9 through the compiler against the real DB | Correct ids (search spec section 12) | First |
| E3 | Generate a seeded synthetic table of 1 M rows (mixed English, Arabic, Chinese text with planted terms) into a disposable database | Enables plans at scale | Next |
| E4 | On E3: `EXPLAIN (ANALYZE, BUFFERS)` for keyset page 1 and page 10,000, a selective FTS query, a substring query for a 2-char and a 3-char Chinese term, a mixed query, the weekly aggregate | Index used; no sort on keyset; trigram usable only for 3+ chars; page 1 vs page 10,000 time equal | Next |
| E5 | Insert 100,000 rows in batches of 100 and 1,000, with and without the trigram index | Rows/s, WAL per row, index sizes (`pg_relation_size`) | Next (feeds section 3 numbers) |
| E6 | Claim contention: 8 workers claiming 100,000 queued jobs | No job claimed twice; claims/s | Next |
| E7 | Budget race: 16 concurrent reservations against a nearly full ledger | Sum of reserved + spent never exceeds the cap | Next |
| E8 | Crash test: kill a worker mid-job | Sweeper returns the job; reserved released; no double result | Next |
| E9 | Restore test | Reconciliation queries pass after `pg_restore` | Last |

Thresholds (proposed; they are observations for the README, not release gates at this scale): keyset p95 under 50 ms at 1 M rows; search p95 under 500 ms; aggregate under 500 ms. For E5 report the measured rows/s and the extrapolated 800/s feasibility.

## 12. Risks and hot paths

| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-DB1 | Migration partly applied or run twice | Broken schema or duplicate objects | P2 | Advisory lock; checksum table; idempotent DDL; re-run test |
| FP-DB2 | Extension unavailable | Migration fails or search unindexed | P3 | Best-effort install; `trgm_index=off` capability; clear log line |
| FP-DB3 | Roles missing or wrong grants | App fails at start, or over-privileged | P2 | Grant tests: `app_read` cannot INSERT or read quarantine |
| FP-DB4 | Visibility timeout shorter than provider timeout | Two workers process one job | P2 | `claim_expires_at` > timeout; stale-worker test |
| FP-DB5 | Budget reservation leaked by a crash | Budget slowly unusable | P2 | Sweeper releases; reconciliation of `reserved_micro` |
| FP-DB6 | `search_text` normaliser changed | Index and query disagree | P3, P5 | `search_text_ver`; backfill script; round-trip test |
| FP-DB7 | Generated column or index added after load | Table rewrite, long lock | P2 | Done in migration 1 on an empty table; later changes concurrent |
| FP-DB8 | Hot budget row | Lock contention at scale | P1 | Growth path: reserve in blocks or per-worker counters |
| FP-DB9 | GIN pending list flush | Latency spike on an insert | P1 | `fastupdate` behaviour observed in E5 |
| FP-DB10 | Bucket boundary in wrong zone | Wrong week | P3 | UTC test (search spec) |
| FP-DB11 | Quarantine payloads kept forever | Privacy and size | P3 | Retention CLI; open-count gauge |

| ID | Path | Why hot | What needs a human | Measurement |
| --- | --- | --- | --- | --- |
| HP-DB1 | Article batch insert (8 indexes incl. trigram GIN) | Every article | Decide batch size and which indexes the newest data carries | E5 rows/s and WAL per row |
| HP-DB2 | Mixed FTS+substring search predicate | Per query | Read the `EXPLAIN` for BitmapOr | E4 |
| HP-DB3 | Keyset list | Per page | Confirm no Sort and flat cost by depth | E4 |
| HP-DB4 | Job claim and finish | Most-updated table | Review the claim SQL, timeout, fillfactor | E6 |
| HP-DB5 | Budget reserve | Single contended row | Review statement and release paths | E7 |
| HP-DB6 | Aggregate with `group_by=topic` | Join to child table | Plan with filters | E4 |

## 13. Handoff

- **carma-devops:** image `postgres` Debian-based, major pinned; `shared_preload_libraries=pg_stat_statements`; settings in section 10; volume; healthcheck `pg_isready`; role passwords and app credentials from environment (no defaults committed); the migrator runs before app and worker start (`depends_on: service_healthy` plus a migrator exit condition); `POSTGRES_INITDB_ARGS`/locale per E1; nightly dump job or documented command.
- **carma-backend-testing:** constraints (`dv_conf_complete`, `articles_has_text`), grant tests, claim/finish/sweeper races, budget race, duplicate ingest, migration re-run, restore reconciliation, null matrix at DB level, E1 to E9.
- **carma-telemetry:** `pg_stat_statements`, table/index sizes, dead tuples on jobs, oldest job age, jobs by state, `reserved_micro` vs sum of running jobs, budget remaining, quarantine open count.
- **carma-benchmark (later):** use a disposable database (`CREATE DATABASE carma_bench`, same migrations), seed with the seeded generator (E3), clean up by `DROP DATABASE`; completeness is read from `ingest_events` and the reconciliation queries.
- **carma-plan:** migration files as tasks; resolve the weight inconsistency (section 4.1); E1 first.

## 14. Decisions needed and open questions

No blocking decisions. Defaults recorded:

| ID | Default | Alternative |
| --- | --- | --- |
| DB1 | Debian-based official Postgres image, major version 16 or newer pinned at build | Alpine (smaller; risk for `pg_trgm` on non-ASCII, see E1) |
| DB2 | Keep the duplicate `search_text` column now | SQL-expression normaliser (saves about half the text storage; growth path) |
| DB3 | Keep succeeded job rows forever (they are the ledger) | Archive after N days (growth path) |
| DS1 (carried) | Retain quarantined payloads 30 days | Hash only |

Open questions: real host RAM/CPU/disk (sizes the settings); real article size and duplicate rate (sizes storage and cache saving); result of E1.

Record DB1 as an ADR via carma-architect if the user wants the image/version choice to be binding.
