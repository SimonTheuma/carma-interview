---
spec: carma-dba
number: 0003
title: Translation storage, search columns and queue changes
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0022-translate-at-ingest-as-enrichment-part.md, .specs/architect/adrs/0023-openai-small-model-chunked-translation.md, .specs/architect/adrs/0024-translation-no-confidence-article-page-only.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/search/0002-article-translation.md, .specs/data/sanitization/0003-article-translation.md, .specs/data/dba/0002-json-file-upload.md]
principles: [P1, P2, P3, P5, P8]
supersedes: null
---

# 0003 Translation storage, search columns and queue changes

## 1. Summary
One migration, `0004_article_translations.sql`, on PostgreSQL 16.6 (DBA 0002). It:
1. Widens the `part` CHECKs on `enrichment_jobs` and `enrichments` to allow `translation`.
2. Adds `article_translations`, an append-mostly table holding the English headline and body, its search text and a generated `tsvector`. `articles` is never written by translation (original and its hash stay untouched, P8).
3. Adds a small `translation_chunk_cache` so a retry reuses validated chunks (sanitization 0003 section 9).
4. Extends the enqueue in `ingestOne` and in `ingest_new_version` to add a `translation` job when the app says the article needs one, and makes `ingest_new_version` supersede the old translation.
5. Adds grants: the worker writes translations, the web reads them.

Main cost: foreign-language articles roughly double their stored text and gain a second GIN index. The one extra insert on the ingest hot path is cheap (HP-1). The trigram index on translations was chosen by the user (ADR-0027); it is the largest index and can be dropped later if unused.

## 2. Inputs and current database state
- `enrichment_jobs.part` and `enrichments.part` are inline CHECKs, so Postgres named them `enrichment_jobs_part_check` and `enrichments_part_check` (`db/migrations/0001_init.sql:52,78`). Verify the names on the live database before dropping (the migration looks them up from `pg_constraint` instead of assuming).
- Job uniqueness is `enrichment_jobs_version_uq (article_id, article_version, part, prompt_version)` (`0003_article_versions.sql:57-60`), so a translation job per version is naturally idempotent.
- Enqueue loop: `src/lib/ingest/ingest.ts:525-541` inserts one job per part in the article transaction; `ingest_new_version` inserts jobs for the new version at `0003_article_versions.sql:179`.
- Current search indexes on `articles`: `articles_fts_idx` GIN on generated `search_vector`, optional `articles_trgm_idx` GIN `gin_trgm_ops` on `search_text` (flag `trgm_index`) (`0001_init.sql:176-188`).
- Roles: `app_ingest` insert-only on `articles` and jobs; `app_worker` UPDATE on jobs, INSERT on `enrichments`/`derived_values`; `app_read` SELECT (`0001_init.sql:224-250`).
- Extensions: `pg_trgm`, `unaccent`, `pg_stat_statements` already present; nothing new needed.
- Unknown: foreign-language share, average translated size, real table sizes, current partitioning (none: `articles` is a single table in this PoC).

## 3. Write budget and capacity model
Symbols: `R` = ingest rate (800/s), `f` = foreign share (UNKNOWN), `B` = average original body size, `T` = translated size, `c` = TOAST compression ratio.

Translation inserts per second = `R × f`, but they are paced by the worker and the LLM budget, not by ingest. For the PoC (50,000 articles/day, ADR-0003) the rate is tiny. For the 800/s design target: at `f = 10%` that is 80 translation rows/s sustained; at `f = 30%` it is 240/s. The LLM concurrency and budget cap this long before Postgres does (the 15-minute freshness target does not apply to translation, which is an enrichment).

Per translated article (assumptions: `B` = 3 KB UTF-8, `T` ≈ 3 KB, text compresses 2.2x in TOAST, tsvector 1.3x):
| Item | Formula | Size |
| --- | --- | --- |
| `headline_en` + `body_en` | `T / c` | about 1.4 KB |
| `search_text` | `T / c` | about 1.4 KB |
| `search_vector` stored | `0.4 × T / 1.3` | about 0.9 KB |
| Row overhead, keys, timestamps | fixed | about 0.2 KB |
| GIN on `search_vector` | `0.8 × tsvector` | about 0.7 KB |
| Trigram GIN on `search_text` (if built) | `1.5 × T` | about 4.5 KB |
| Chunk cache (temporary) | `T` for 7 days | about 3 KB, then purged |
Heap about 4 KB, plus GIN about 0.7 KB, plus trigram about 4.5 KB: about 9.5 KB per translation as built (about 5 KB without the trigram index).

Daily growth = `R × 86,400 × f × size`. With `R = 800`: 69.1M articles/day.
| f | without trigram (5 KB) | with trigram (9.5 KB) |
| --- | --- | --- |
| 10% | about 35 GB/day | about 66 GB/day |
| 30% | about 104 GB/day | about 197 GB/day |
For the PoC (50,000/day, f = 30%): about 75 MB/day without trigram. These are example numbers from stated assumptions; replace with a measurement of 10,000 real translations (first experiment). The translation roughly adds `f × (5 KB / original article size on disk)` to total storage, about 15 to 50 percent of the heap share at `f` of 10 to 30 percent.

## 4. Schema
Illustrative sketch, not the final migration.

```sql
-- 0004_article_translations.sql
-- widen part CHECKs (names looked up, not assumed)
ALTER TABLE enrichment_jobs DROP CONSTRAINT enrichment_jobs_part_check;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_part_check
  CHECK (part IN ('sentiment','summary_topics','translation'));
ALTER TABLE enrichments DROP CONSTRAINT enrichments_part_check;
ALTER TABLE enrichments ADD CONSTRAINT enrichments_part_check
  CHECK (part IN ('sentiment','summary_topics','translation'));
-- enrichments_current_uq (article_id, part) WHERE superseded_at IS NULL already covers 'translation'.

CREATE TABLE article_translations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_id       bigint      NOT NULL REFERENCES articles(id),
  article_version  integer     NOT NULL,
  target_lang      text        NOT NULL DEFAULT 'en',
  source_lang      text,                       -- as supplied
  detected_lang    text,                       -- reported by the model (data-sanity check 4)
  headline_en      text,                       -- NULL when absent, never ''
  body_en          text,
  search_text      text        NOT NULL,       -- app normaliser output, same as articles.search_text
  search_text_ver  smallint    NOT NULL,
  search_vector    tsvector GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,
  enrichment_id    bigint      NOT NULL REFERENCES enrichments(id),  -- provider, model, prompt, cost, trust
  chunk_count      smallint    NOT NULL,
  flags            text[]      NOT NULL DEFAULT '{}',   -- lang_unknown, flag_numbers, replaced_invalid_utf8
  created_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at    timestamptz,
  CONSTRAINT at_has_text CHECK (headline_en IS NOT NULL OR body_en IS NOT NULL)
) WITH (fillfactor = 90);

-- one current translation per article and target language
CREATE UNIQUE INDEX article_translations_current_uq
  ON article_translations (article_id, target_lang) WHERE superseded_at IS NULL;
CREATE INDEX article_translations_fts_idx
  ON article_translations USING GIN (search_vector) WHERE superseded_at IS NULL;

CREATE TABLE translation_chunk_cache (
  job_id      bigint      NOT NULL REFERENCES enrichment_jobs(id) ON DELETE CASCADE,
  chunk_idx   smallint    NOT NULL,
  input_hash  bytea       NOT NULL,   -- sha256 of fenced input + prompt_version
  output      text        NOT NULL,   -- validated chunk
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, chunk_idx)
);
```
Design points
- **Version binding (FP-6, FP-S2).** `article_version` is stored, and the web query joins `t.article_version = a.version` as well as `superseded_at IS NULL`, so a late translation of an old version can never display or match.
- **No NOT NULL on text columns that can legitimately be absent** (`headline_en`, `body_en`), with the CHECK that at least one exists; matches the sanitization rule that absence is NULL, never `''`.
- **No confidence columns.** ADR-0024; "no confidence available" is the absence of a `derived_values` row for field `translation`, and the page says so. Origin, model, prompt version and cost live on the linked `enrichments` row (P7).
- **Why a table, not `derived_values`.** `derived_values.value` is a short value with a mandatory confidence block (`0001_init.sql:98-120`); translated text is long, searchable and version-bound. A narrow table with its own search columns is the honest shape.
- **`search_text` duplicates the text** (normaliser output differs from display text). Alternative: generate the vector from `headline_en || body_en`. Rejected: the app normaliser (NFKC, folding) must match the query-side `normaliseLeafTerm` (FP-S3), and generated columns cannot call it. Cost: about 1.4 KB per row, accepted.
- **Chunk cache.** `ON DELETE CASCADE` from the job; rows are purged 7 days after the job reaches a terminal state by the existing sweeper (`src/worker/sweeper.ts`) rather than by a new scheduler. It is small and short-lived, so no index beyond the primary key.

### Enqueue (hot path) and new version
- `ingestOne`: after the two existing job inserts, `INSERT INTO enrichment_jobs ... part = 'translation'` when the **app** decides the article needs translation (`isEnglish(language)` is false). The decision is passed as a boolean, also to `ingest_new_version(..., p_needs_translation boolean)`, so the language rule lives in one place (TypeScript) and SQL does not copy it (drift would be FP-1). Unknown or missing language counts as "needs translation" (sanitization 0003 section 3). No text: `skipped_no_content` as for the other parts.
- Combine the three job inserts into one multi-row `INSERT ... VALUES (...),(...),(...)` to keep the statement count equal to today's per-article cost plus zero (HP-1). Today it is a loop of two statements (`ingest.ts:526-541`).
- `ingest_new_version`: add (a) `UPDATE article_translations SET superseded_at = now() WHERE article_id = ... AND superseded_at IS NULL`, (b) supersede old `translation` jobs along with the others (already covered by the generic job supersede at `0003_article_versions.sql:155`), (c) insert the new `translation` job when `p_needs_translation`. The function is replaced with `CREATE OR REPLACE`; the signature gains a parameter, so the old overload is dropped explicitly and the grant repeated (the `GRANT EXECUTE ... (full arg list)` must be updated, `0003:211`).

## 5. Extension plan
| Extension | Purpose | Principle | Cost | Burden | Availability | Core fallback |
| --- | --- | --- | --- | --- | --- | --- |
| `pg_trgm` | Substring search on translated text | P3 | Large index (section 3) | None, already installed | Present | Skip it on the translation side (recommended) |
| None other | | | | | | |
Package: core plus what is already installed. No new extension. Vectors and a translation-aware CJK config are not needed because the target is English and the existing `simple` config is used.

## 6. Partitioning and retention
`articles` is a single table in this PoC and translations follow it: no partitioning for `article_translations` at PoC scale. At the 800/s design target, partition it by the same key as `articles` (published_at of the article, by day) so retention drops both together; this needs `published_at` copied onto the translation row or a partition key via the article. Recorded as a scale-up note, not built now (UNCONFIRMED whether scale-up is in scope).
Retention: translations live as long as their article. Superseded translations (old versions) are kept 30 days for audit (same spirit as ADR-0011), then deleted by a sweeper job; they are excluded from the partial indexes so they cost nothing for search.

## 7. Index inventory
| Index | Type | Columns | Serves | Write cost | Build |
| --- | --- | --- | --- | --- | --- |
| `article_translations_pkey` | B-tree | `id` | row identity | low | with table |
| `article_translations_current_uq` | partial unique B-tree | `(article_id, target_lang) WHERE superseded_at IS NULL` | page lookup, one-current rule, search EXISTS join | low | with table |
| `article_translations_fts_idx` | partial GIN | `search_vector WHERE superseded_at IS NULL` | English term search (ADR-0025) | medium, worker-paced | with table; for backfill, create after the load |
| `article_translations_trgm_idx` | partial GIN | `search_text gin_trgm_ops WHERE superseded_at IS NULL` | substring leaves (non-Latin terms, names kept in their own script) on translations (ADR-0027) | high (largest index) | with the table, guarded like `articles_trgm_idx` (`trgm_index` flag); `CONCURRENTLY` on a populated table |
| `tc_job_idx` | none needed | cache PK covers it | | | |
Trigram on translations was chosen by the user (ADR-0027). `classifyLeaf` (`src/lib/search/leaf.ts`) sends only Arabic, Chinese, Japanese terms to the substring path, so the index serves non-Latin terms that survive inside an English translation (brand and proper names are kept as written, sanitization 0003). It does not enable Latin partial-word search. It is the largest and least likely to be hit index: watch `pg_stat_user_indexes` after release and drop it if unused.
GIN `fastupdate` stays on (default): translation inserts are worker-paced, and the pending list is merged by autovacuum and on search. Watch `gin_pending_list_limit` effects on p99 search (verification plan).

## 8. Write path design
- **Worker insert (one transaction).** Take the same advisory lock as `ingest_new_version` (`pg_advisory_xact_lock(hashtext('article'), article_id)`, DBA 0002 section 8), re-check `articles.version = job.article_version`, supersede any current translation, insert the `enrichments` row (part `translation`), insert the `article_translations` row, mark the job `succeeded`, delete the job's cache rows. If the version changed, mark the job `superseded_version` and write nothing (existing worker pattern, `loop.ts` lines around version check). This closes the race where a slow translation of v1 lands after v2 arrived (FP-6).
- **Idempotency.** `article_translations_current_uq` makes a duplicate insert for the same article fail fast; the job unique key prevents duplicate jobs. A crash after the insert but before `succeeded`: the claim expires, the job is claimed again, the insert conflicts on the unique index, and the worker treats the conflict as already done only if the stored `enrichment_id`/`article_version` match the job, otherwise it supersedes and rewrites.
- **Batching.** Not batched: one article per transaction, translation volume is LLM-bound.
- **Durability.** No change: default synchronous commit. A lost translation is recoverable by re-queuing the job; the original is already durable, so the relaxed-commit question is out of scope (no new decision).
- **Cache writes.** Insert per validated chunk in its own small transaction (so a crash at chunk 7 keeps chunks 1 to 6). Reserved budget per job is unchanged from ADR-0010.

## 9. Search read path and isolation
Compiled shape (search 0002 section 5), per term leaf:
```sql
( <predicate on a.*>
  OR EXISTS (SELECT 1 FROM article_translations t
              WHERE t.article_id = a.id AND t.article_version = a.version
                AND t.superseded_at IS NULL
                AND t.search_vector @@ plainto_tsquery('simple', $n)) )
```
Substring-kind leaves use ILIKE against `t.search_text` (trigram GIN); NOT terms are compiled against the original side only (ADR-0027). The partial unique index serves the join; the partial GINs serve `@@` and ILIKE.
Plan experiment (HP-S1/HP-DB2) on a seeded set: 200k articles, 30 percent foreign, 100 percent of foreign translated; compare (A) OR + EXISTS, (B) `a.id IN (translation matches)` UNION `original matches`, (C) two bitmap scans on `a.search_vector` and `t.search_vector` ORed through a join. Measure p50 and p99 for a rare term, a common term, a phrase, a NOT query, with keyset ordering and LIMIT. Accept A unless p99 exceeds 1 s on the 2 s `app_read` timeout; then pick B. The reader pool is the existing read-only pool; replicas are not in this PoC.
Page read: one query `SELECT ... FROM article_translations WHERE article_id = $1 AND target_lang = 'en' AND superseded_at IS NULL AND article_version = $2` via the unique index.

## 10. Operations
- **Vacuum.** `article_translations` is insert-mostly; the only update is `superseded_at`, which changes membership in the partial indexes, so not HOT-eligible. `fillfactor = 90`, `autovacuum_vacuum_scale_factor = 0.05`, `autovacuum_analyze_scale_factor = 0.05` on the table. The cache table sees insert and cascade delete: `autovacuum_vacuum_scale_factor = 0.02`.
- **Statistics.** Run `ANALYZE article_translations` after any backfill, before the search experiment.
- **Monitoring** (to carma-telemetry): table and index sizes, GIN pending list size, cache table row count and oldest row, translation insert latency.
- **Backup.** Included in the existing dump/PITR; translations are re-creatable but cost money, so they are not excluded.
- **Migration safety.** `ALTER TABLE ... DROP/ADD CONSTRAINT` on the job tables takes a brief ACCESS EXCLUSIVE lock and scans rows for validation. Use `ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` to avoid a long lock on a large `enrichment_jobs`. New tables lock nothing. `CREATE OR REPLACE FUNCTION` is instant.
- **Backfill** (not done, ADR-0028; kept for reference): enqueue translation jobs for existing foreign articles in batches of 1,000 by `INSERT ... SELECT` with `ON CONFLICT DO NOTHING`, rate-limited by the ADR-0010 budget; drop the GIN first and rebuild after only for very large loads.
- **Rollback** (manual, after code rollback):
  ```sql
  -- 1. stop translation: UPDATE system_flags SET value='false' WHERE key='translation_enabled';
  -- 2. restore ingest_new_version from 0003 (previous signature) and re-grant EXECUTE
  -- 3. DROP TABLE translation_chunk_cache; DROP TABLE article_translations;
  -- 4. DELETE FROM enrichments WHERE part='translation' (and jobs); then restore the two
  --    part CHECKs to ('sentiment','summary_topics')
  ```
  Prefer `docker compose down -v` for disposable environments. Originals are never modified, so rollback loses no source data.
- **Grants** (in the migration):
  ```sql
  GRANT SELECT ON article_translations TO app_read;
  GRANT SELECT, INSERT ON article_translations TO app_worker;
  GRANT UPDATE (superseded_at) ON article_translations TO app_worker;
  GRANT SELECT, INSERT, DELETE ON translation_chunk_cache TO app_worker;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_worker;  -- already granted
  ```
  `app_read` gets no right on the cache table (internal state). `app_ingest` gets nothing new: its job insert right already covers the `translation` part, and it never touches translations.

## 11. Verification plan
First experiment: translate 10,000 sample foreign articles (mock provider for volume, a 200-article real-model sample for size) and measure heap, TOAST and index sizes per row; replace section 3 numbers.
Then:
1. **Ingest regression (HP-DB1).** carma-benchmark: insert 100,000 articles with 0 percent and with 30 percent foreign, single-row `ingestOne` versus multi-row job insert. Pass: rows/s with the translation enqueue is within 5 percent of today's.
2. **Search plans (HP-DB2).** Section 9 experiment; capture `EXPLAIN (ANALYZE, BUFFERS)`.
3. **Worker insert.** 50 concurrent translation completions plus 50 concurrent new versions of the same articles: no two current rows, no orphan current translation for an old version.
4. **Crash test.** Kill the worker between chunk 7 and the final insert: the retry reuses chunks 1 to 6, ends with exactly one current translation.
5. **Constraint migration.** Run `0004` on a database with 1M job rows; record lock time.
6. **GIN pending list.** Insert at the maximum translation rate while running searches; watch p99 search latency.
Unknowns: foreign share, real sizes, `gin_pending_list_limit` effect.

## 12. Risks and hot paths
| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-DB1 | `ingest_new_version` signature change leaves the old overload callable, so a path skips the new parameter | New versions lose their translation job | P3 | Test calls both; drop old overload; reconciliation FP-1 |
| FP-DB2 | Race: translation of v1 inserts after v2 | Wrong-version text shown or matched | P8 | Concurrency test, `article_version` join |
| FP-DB3 | CHECK widening locks `enrichment_jobs` | Ingest stalls briefly | P2 | `NOT VALID`/`VALIDATE`, lock-time measurement |
| FP-DB4 | Search OR/EXISTS plan regresses | Searches time out at 2 s | P1 | Plan experiment, latency metric |
| FP-DB5 | Chunk cache never purged | Slow growth | P2 | Cache row-age metric, sweeper test |
| FP-DB6 | Trigram index added later without CONCURRENTLY | Lock on writes | P2 | Review checklist |
| HP-DB1 | Job insert in `ingestOne` and `ingest_new_version` | Per article, 800/s | One extra row per foreign article; confirm multi-row insert, no extra round trip | rows/s benchmark above |
| HP-DB2 | Search query with EXISTS on translations | Interactive, every search | Human reads the plan for a rare and a common term | p99 per plan |
| HP-DB3 | Worker's translation insert transaction | Holds advisory lock and writes ~5 KB | Keep chunk cache writes outside it | insert latency |

## 13. Handoff
- carma-benchmark: seed with a configurable foreign share and a mock translator that produces deterministic English text; completeness check: foreign articles = translated + queued + deferred + dead + skipped (read from `enrichment_jobs` where `part = 'translation'`); clean-up: `TRUNCATE article_translations, translation_chunk_cache` plus the normal reset.
- carma-devops: no image or extension change; migration `0004` runs in the existing `migrate` service; new settings (translate model, concurrency, budget share, `translation_enabled` flag) in config; grants are in the migration.
- carma-telemetry: table and index sizes, GIN pending size, cache age, translation insert latency, jobs by state for the `translation` part, search latency with and without translation matches.
- carma-backend-testing: sections 11 and FP-DB1 to FP-DB6.
- carma-plan: migration first, then enqueue and worker, then compiler, then UI; the compiler change cannot ship before the table and index exist.

## 14. Decisions needed and open questions
- Decided (ADR-0027): trigram index on translations is built; review its usage after release.
- Retention of superseded translations: 30 days proposed, UNCONFIRMED.
- Backfill: decided no (ADR-0028).
- Partitioning for scale-up: noted, not built.
- Foreign share and real sizes: unknown until the first experiment.
