---
spec: carma-dba
number: 0004
title: English stemmed search index and English excerpt on search results
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/architect/adrs/0030-english-stemming-index-for-default-search.md, .specs/architect/adrs/0033-unquoted-terms-match-stem-or-substring.md, .specs/architect/adrs/0032-english-first-display-with-original-underneath.md, .specs/search/0003-english-first-substring-search.md, .specs/data/dba/0003-article-translation.md]
principles: [P1, P2, P3, P5]
supersedes: null
---

# 0004 English stemmed search index and English excerpt on search results

## 1. Summary
One schema change and one query change:
1. An English-stemmed full-text index on `articles.search_text` and on current `article_translations.search_text` (ADR-0030).
2. The search list query also returns `left(body_en, 600)` of the current translation (ADR-0032).

No new table, no new extension, no change to roles beyond what `app_read` already has. The trigram indexes that serve the literal-substring branch (ADR-0033) already exist on both tables.

**Reverses an earlier statement:** architect spec 0004 section 1 said no migration was expected; ADR-0030 requires one. The cheapest safe form of it is the main DBA choice (section 4).

## 2. Inputs and current database state
| Item | Finding | Evidence |
| --- | --- | --- |
| PostgreSQL | 16.6 | `compose.yaml:32` (`postgres:16.6-bookworm`) |
| Extensions | `pg_trgm`, `unaccent`, `pg_stat_statements` already created; no new one needed | `db/migrations/0001_init.sql:27-29` |
| `articles` | Single table, not partitioned, identity key, generated `search_vector` (`simple`), GIN `articles_fts_idx` and trigram `articles_trgm_idx` | `0001_init.sql:36-46,176-183` |
| Updates | `articles` is updated for new versions (`ingest_new_version` sets `search_text`), so DBA 0001's "no updates" no longer holds; generated columns recompute on that update | `0003_article_versions.sql:130-145` |
| `article_translations` | Generated `search_vector` (`simple`), partial GIN and partial trigram on `superseded_at IS NULL`, `fillfactor = 90` | `0004_article_translations.sql:60-107` |
| Grants | `app_read` has SELECT on both tables; a new index needs no grant | `0004:123` |
| Migration runner | Plain SQL files in order, each in a transaction unless the file contains `-- no-transaction`; advisory lock; checksum guard | `src/lib/db/migrate.ts:20-80` |
| Trigram availability flag | `system_flags.trgm_index` | `0001:179-187` |
| Not known | Real row counts, real foreign share, whether trigram is on in the target database | UNCONFIRMED |

The migration runs at every `docker compose up`, so a heavy migration blocks start-up (devops concern).

## 3. Write budget and capacity model
Assumptions (replace with measurement, first experiment in section 11): average article text 3 KB (context file 1 to 5 KB); translation text about the same; PoC rate 50,000 articles a day (0.58/s), design target 800/s.

| Item | Estimate (hypothesis) |
| --- | --- |
| Extra CPU per row, `to_tsvector('english', 3 KB)` | tens to low hundreds of microseconds; at 800/s roughly 0.04 to 0.16 core |
| Extra GIN size per article | stemming and stop-word removal usually make this index no larger than the `simple` one; guess 0.3 to 0.5 of the text size, about 1 to 1.5 KB per 3 KB article |
| Extra storage at 800/s | 69.1M articles a day times about 1 to 1.5 KB is about 70 to 100 GB a day of index, before translations; this is the cost that makes the choice a first-order one at target scale |
| Extra storage at PoC rate | 50,000 times 1.5 KB is about 75 MB a day |
| Extra per translation | Same ratio on the translation text, partial index (current rows only) |
| GIN maintenance | `fastupdate` pending list: writes are cheap, the pending list is merged by vacuum or when it passes `gin_pending_list_limit`; a large pending list slows the unlucky query |

At the PoC rate none of this threatens throughput. At 800/s it adds a second heavy GIN to the hot write path (HP-DB1), on top of the existing `simple` GIN and the trigram GIN (the trigram index is already called out as the most expensive, DBA 0001).

## 4. Schema: how to hold the English vector
Options. Reserved-word check: new identifiers are `search_vector_en`, `articles_fts_en_idx`, `article_translations_fts_en_idx`; none is a PostgreSQL keyword (`pg_get_keywords()` not run here because no database was reachable; run it at build time).

| Option | Migration | Table rewrite | Null / backfill state | Query | Storage |
| --- | --- | --- | --- | --- | --- |
| A. Generated stored column `search_vector_en` (matches the existing `search_vector` pattern) | `ADD COLUMN ... GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED` | **Yes**: full rewrite of `articles` under ACCESS EXCLUSIVE lock | None: always populated | `a.search_vector_en @@ ...` | Heap grows by the vector (TOAST'd) plus index |
| B. Plain nullable column + trigger + batch backfill | Add column (instant), trigger, batched `UPDATE`, concurrent index | No lock, but the backfill updates every row (bloat, WAL) | Yes: null until backfilled | same as A | Same as A |
| C. Expression index only (recommended) | `CREATE INDEX CONCURRENTLY ... USING GIN (to_tsvector('english', search_text))` | **No** rewrite, no heap column | **None**: the index is valid atomically when the build finishes; until then queries are correct but cannot use it | Query must repeat the exact expression: `to_tsvector('english', a.search_text) @@ ...` | Index only |

Option C trade-offs: no rewrite, no extra heap column, no null-before-backfill state (so search spec 0003 section 11's backfill note and FP-S9 mostly disappear), and expression-index statistics are gathered by `ANALYZE` for planning. Costs: the search compiler must emit the identical expression (a typo silently disables the index, so a plan test is mandatory), and if a bitmap scan becomes lossy the vector is recomputed per row at recheck (a CPU cost visible in EXPLAIN). Option A's advantage is consistency with the existing columns and simpler queries; its cost is a table rewrite, which is harmless at PoC size and severe at target size.

Recommendation: **C** for both tables. `article_translations` is small and current-only, so A would also be fine there, but one pattern is simpler to test. This is a refinement of ADR-0030 (which said "generated and GIN-indexed"), so it needs the user's confirmation (D-DB1).

DDL sketch (illustration, not a migration), option C. The file starts with `-- no-transaction` because `CREATE INDEX CONCURRENTLY` cannot run in a transaction block:
```sql
-- no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_fts_en_idx
  ON articles USING GIN (to_tsvector('english', search_text));
CREATE INDEX CONCURRENTLY IF NOT EXISTS article_translations_fts_en_idx
  ON article_translations USING GIN (to_tsvector('english', search_text))
  WHERE superseded_at IS NULL;
```
Rollback: `DROP INDEX CONCURRENTLY` both; queries fall back to the substring branch only. An interrupted concurrent build leaves an invalid index that must be dropped and rebuilt; the migration should check `pg_index.indisvalid` afterwards and fail loudly.

Caution for a partial index: the query must also contain `superseded_at IS NULL` (it already does through the EXISTS predicate) or the planner will not use the partial index.

### 4.1 Amendment A (ADR-0035): stemming scope and summaries
Supersedes the index list above where they differ. Four expression indexes, all built concurrently in the same `-- no-transaction` migration:
| Index | Definition (sketch) | Notes |
| --- | --- | --- |
| `articles_fts_en_idx` | `GIN (to_tsvector('english', search_text)) WHERE split_part(language, '-', 1) IN ('en', 'und')` | Partial: English and unknown-label originals only. `split_part` is immutable, so it is allowed in a predicate. The query must repeat the same predicate text for the planner to use it (FP-DB1 widens to predicate and expression) |
| `article_translations_fts_en_idx` | `GIN (to_tsvector('english', search_text)) WHERE superseded_at IS NULL` | As before |
| `derived_values_summary_fts_en_idx` | `GIN (to_tsvector('english', value)) WHERE field = 'summary' AND is_current` | New; summaries are short (hundreds of characters), so the index is small |
| `derived_values_summary_trgm_idx` | `GIN (value gin_trgm_ops) WHERE field = 'summary' AND is_current` | New; serves the substring branch on summaries; shares the `trgm_index` flag behaviour |
Cost: the partial `articles` index is smaller than the unconditional one (foreign originals excluded; the saving depends on the foreign share, UNKNOWN); the two summary indexes add a small write cost per enrichment, in the worker, not on the ingest path. Quoted terms on summaries use `to_tsvector('simple', value)` with a phrase query; to avoid a fifth index, the quoted summary match is evaluated as a recheck on rows already narrowed by the English index or by `article_id` (summaries are one row per article), which is cheap at that size; measure in E9.
Query shape for the summary side: `EXISTS (SELECT 1 FROM derived_values dv WHERE dv.article_id = a.id AND dv.field = 'summary' AND dv.is_current AND (<stem or substring or exact predicate on dv.value>))`. `app_read` already has SELECT on `derived_values` (cards read it). New experiments: **E9** plan uses both summary indexes and the existing `article_id` access path; **E10** `articles` partial index is chosen only when the query contains the same predicate; **E11** NOT never references the summary.
Risks added: FP-DB6 summary row superseded by a new version but `is_current` not cleared (verify the worker flips it in `finish.ts`); FP-DB7 summary language is not English (stem degrades, substring still works).

### 4.2 Amendment B (2026-10-28, ADR-0036): final index set
Default stemming and substring matching are gone; the English indexes now serve only `*` terms. Supersedes sections 3 to 9 and Amendment A wherever they mention a substring branch, trigram use on Latin text, `short_stem`, or the "stem OR substring" query shape.
| Index | Definition (sketch) | Serves |
| --- | --- | --- |
| `articles_fts_en_idx` | `GIN (to_tsvector('english', search_text)) WHERE split_part(language, '-', 1) IN ('en', 'und')` | stem half of `*` on English/`und` originals |
| `article_translations_fts_en_idx` | `GIN (to_tsvector('english', search_text)) WHERE superseded_at IS NULL` | stem half of `*` on translations |
| `derived_values_summary_fts_en_idx` | `GIN (to_tsvector('english', value)) WHERE field = 'summary' AND is_current` | stem half of `*` on summaries |
| `derived_values_summary_fts_idx` (**new in this amendment**) | `GIN (to_tsvector('simple', value)) WHERE field = 'summary' AND is_current` | exact bare terms, phrases and prefix on summaries |
- **Dropped:** `derived_values_summary_trgm_idx`, and any new trigram index. Existing trigram indexes on `articles` and `article_translations` stay for Arabic/Chinese terms only.
- Exact, phrase and prefix on original and translation use the existing `search_vector` GIN indexes; no new index.
- Migration `0007` therefore creates four indexes (same names as before except the summary trigram is replaced by the `simple` summary index), still `-- no-transaction`, concurrent.
- Query shapes: bare/phrase use `@@ plainto_tsquery('simple', ...)` / `phraseto_tsquery`; wildcard uses `(prefix_predicate OR to_tsvector('english', ...) @@ plainto_tsquery('english', $n))` where `prefix_predicate` is `to_tsquery('simple', 'renew:*')` on the `simple` vector; the stem half is omitted for foreign-labelled originals. Summary side is an `EXISTS` over `derived_values` with the partial-index predicate repeated.
- Experiments: E2 plan check applies to wildcard terms only; E3 compares prefix OR stem shapes (OR/EXISTS versus UNION); E4 NOT with a wildcard; E9 uses the two summary indexes; E10 language predicate. Bare terms must show no regression versus the pre-change baseline (they use existing indexes only).
- Write cost: only the English indexes and one `simple` summary index are new; at the PoC rate negligible; HP-DB1 benchmark unchanged in purpose.
- Risk change: FP-DB5 now means a stop-word wildcard (`the*`) producing an empty stem query (prefix half still answers).

## 5. Extension plan
| Extension | Purpose | Principle | Cost | Availability | Core fallback |
| --- | --- | --- | --- | --- | --- |
| `pg_trgm` (already in use) | Literal substring branch (ADR-0033) | P3 | Largest index already paid for | Verified in migrations; flag `trgm_index` records runtime state | `ILIKE` scan |
| English text-search config | Stemming | P3 | Built into core, no extension | Core | n/a |

No package decision needed: core only plus what is installed.

## 6. Partitioning and retention
Unchanged: `articles` is one table in the PoC. A migration to time partitions at target scale would make a concurrent index build per partition cheap and the GIN per-partition smaller; the stemmed index should be added to the partition template when that happens (carry forward to DBA 0001's growth path).

## 7. Index inventory (additions)
| Index | Type | Serves | Write cost | Built | Verified by |
| --- | --- | --- | --- | --- | --- |
| `articles_fts_en_idx` | GIN, expression `to_tsvector('english', search_text)` | Unquoted Latin term, stem branch, original side | Highest of the three GINs per article after trigram | Concurrently, once, at migration | EXPLAIN shows Bitmap Index Scan on it |
| `article_translations_fts_en_idx` | partial GIN, same expression, `WHERE superseded_at IS NULL` | Stem branch, translation side | Per translation insert | Same | EXPLAIN |
| existing `articles_trgm_idx`, `article_translations_trgm_idx` | trigram GIN | Literal substring branch, both sides | Already paid | Existing | EXPLAIN for `ILIKE '%start%'` |

Existing `articles_fts_idx` (`simple`) is kept for quoted exact terms and wildcards, so no index is removed. Open optimisation for target scale (not now): evaluate whether quoted exactness could be served by the English index plus a recheck, to drop one GIN. Not recommended without measurement, because it changes the meaning of "exact".

## 8. Write path design
- Ingest path: `INSERT`s into `articles` only maintain the new index; no code change. The generated `search_vector` is unaffected.
- `ingest_new_version` updates `search_text`, which updates all three text indexes. Not HOT because indexed columns change; at PoC volume irrelevant.
- Worker translation insert (`src/worker/finish.ts:276`): one more GIN entry per row; no code change.
- No durability setting changes. No batching change.

## 9. Search read path and isolation
- The stemmed branch per unquoted Latin term: `to_tsvector('english', a.search_text) @@ plainto_tsquery('english', $n)`; the substring branch is the existing ILIKE with trigram. Each side is `(stem OR sub)`, two sides, so up to four predicates per term plus the version/`superseded_at` filters on the translation side. The planner can bitmap-OR the two indexes on one relation; across the `EXISTS` subquery it generally cannot, so the plan may become a keyset index scan with a per-row filter, which is fine for common terms and slow for rare ones (HP-DB2).
- Search excerpt: add `left(tr.body_en, 600) AS body_excerpt_en` beside `tr.headline_en` in the list query (`src/lib/search/run.ts:111-113`). The `LEFT JOIN` to the current translation already exists, so no new join. Cost: `body_en` is TOASTed and likely compressed, so `left()` detoasts the whole value for each returned row; with a page size of about 50 rows and a few KB per body this is negligible (about 100 to 250 KB of detoasting per page). Do not add the excerpt to `WHERE` or `ORDER BY`. No new column or index is warranted.
- The `matched_in` `CASE` expression repeats every predicate; it should be evaluated only for returned rows. Confirm in EXPLAIN that it is not evaluated for all candidate rows (HP-DB2).
- Statement timeout and read role unchanged.

## 10. Operations
- Vacuum: new GIN indexes grow pending lists; the existing autovacuum settings on `article_translations` (scale factor 0.05) already cover it; `articles` uses defaults, so check `gin_pending_list_limit` effects in the soak test.
- Monitoring (to carma-telemetry): size of each new index; GIN pending list size; build progress via `pg_stat_progress_create_index`; `pg_index.indisvalid`.
- Migration safety: option C takes `SHARE UPDATE EXCLUSIVE` (writes continue) but reads the whole table, so the build time scales with table size; run in the migration phase before the app serves traffic or accept a slower start. The runner holds an advisory lock, so a second migrate waits. A failed build leaves an invalid index (see section 4).
- Rollback per step: section 4.
- Backup: indexes are rebuilt on restore; restore time grows by the extra index build.

## 11. Verification plan
First experiment: load 100,000 articles at the sample shape (30 percent foreign with the mock translator), then measure: heap size, each GIN size (`pg_relation_size`), build time of each index, and insert rows/s with and without the new indexes. Replace section 3's guesses.

| Experiment | Question | Pass threshold |
| --- | --- | --- |
| E1 Ingest regression (carma-benchmark) | Rows/s with the extra GIN versus today, 100k rows | Within 15 percent of today (HP-DB1); anything worse is reported to the user with the cost per index |
| E2 Plan check, stem-only term | `startups` uses `articles_fts_en_idx` and the translation partial index | Bitmap Index Scan on both; no Seq Scan on `articles` |
| E3 Plan check, stem OR substring | Planner behaviour for `(A OR B)` on `a` plus the EXISTS on `t` | Compare: current OR/EXISTS form versus `a.id IN (SELECT article_id FROM article_translations WHERE ...)` UNION form; pick the one with the lower p95 on 100k articles, 30 percent translated |
| E4 NOT with substring | `x AND NOT startups` plan | No Seq Scan of text on the NOT side beyond the filter |
| E5 Rare versus common term | Keyset scan versus bitmap choice | p95 under the 2 s read timeout for both |
| E6 Expression match | The emitted query text matches the index expression | A test fails if EXPLAIN stops showing the index (guards the silent typo in option C) |
| E7 Excerpt | List query latency with `body_excerpt_en` versus without | Under 10 percent difference at 50 rows |
| E8 Soak | GIN pending list after 1 hour of mixed ingest and search | Stable, no growth trend |

## 12. Risks and hot paths
| ID | Failure point | Effect | Detection |
| --- | --- | --- | --- |
| FP-DB1 | Expression text in the query differs from the index expression | Index unused, sequential scans, timeouts | E6 plan test |
| FP-DB2 | Concurrent build interrupted, invalid index left | Stemmed branch scans | `indisvalid` check in migration and in readiness |
| FP-DB3 | Migration holds start-up for a long time on a big table | `docker compose up` slow or times out | Build-time measurement, run once outside start-up if large |
| FP-DB4 | Partial index not used because the predicate is missing | Slow translation side | E2 plan check |
| FP-DB5 | `plainto_tsquery('english', ...)` returns an empty query for a stop-word-only term | Silent zero results | Search spec 0003 empty-query guard and test |
| HP-DB1 | Extra GIN on `articles` insert and on translation insert | 800 rows/s write path | E1 |
| HP-DB2 | Search query with up to four predicates per term and a repeated `CASE` | Every search | E3 to E5 |

## 13. Handoff
- **carma-benchmark (after code):** seed 100k articles including foreign ones with the mock translator into a disposable database; read counts from `articles` and `article_translations`; run E1 and E3.
- **carma-devops:** migration file number 0007 with `-- no-transaction`; confirm the runner and the compose start-up wait tolerate the build time; no image, extension, role or backup change.
- **carma-backend-testing:** E2 to E7 as integration tests; invalid-index case; stop-word-only term; version/supersede test on the new index.
- **carma-telemetry:** section 10 monitoring items.
- **carma-plan:** one migration task, one compiler task, one list-query task; order: migration, compiler, query, UI.
- Search spec 0003 needs a small amendment if D-DB1 option C is chosen: sections 3 and 11 refer to a column `search_vector_en` and a null-before-backfill state; with an expression index they become the expression and no such state.

## 14. Decisions needed and open questions
- **D-DB1 (confirm with the user):** hold the English vector as an expression index (option C, recommended) instead of a generated stored column (option A, as ADR-0030 worded it). Gains: no table rewrite, no null state. Costs: query must repeat the expression exactly; per-row recompute on lossy recheck.
- Open: real table sizes and foreign share, which decide whether E1 passes.
- Open (target scale only): index size of roughly 70 to 100 GB a day at 800/s against retention and storage; revisit with measurement.
- UNCONFIRMED: `pg_trgm` is available in the target database.
