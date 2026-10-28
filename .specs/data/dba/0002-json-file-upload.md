---
spec: carma-dba
number: 0002
title: Article versioning, upload grants and batch status for the JSON upload
status: draft
date: 2026-10-24
feature: json-file-upload
inputs: [.specs/architect/0002-json-file-upload.md, .specs/data/sanitization/0002-json-file-upload.md, .specs/data/dba/0001-media-signal-service.md, .specs/architect/adrs/0019-upload-route-uses-ingest-pool-synchronous.md, .specs/architect/adrs/0021-changed-resubmission-stored-as-new-version.md]
principles: [P2, P3, P6, P7, P8]
supersedes: null
---

# 0002 Article versioning, upload grants and batch status

## 1. Summary
One new migration, `0003_article_versions.sql`, on PostgreSQL 16.6. It does four things:
1. **Versioning (ADR-0021).** `articles` keeps meaning "the current version of each (source, external_id)", so search, facets, aggregates, status and the keyset indexes are untouched and a search can never show two versions of one article. Superseded versions move to a new append-only `article_versions` table. The swap happens only inside a `SECURITY DEFINER` function, `ingest_new_version(...)`, so `app_ingest` still has no `UPDATE` right on `articles`.
2. **Enrichment per version.** `enrichment_jobs` and `enrichments` gain `article_version`; the function supersedes the old version's results and queues jobs for the new text in the same transaction. Until they finish the article honestly shows "not yet enriched" (P3, P6).
3. **Batch status for the UI** through a `SECURITY DEFINER` function `upload_batch_status(uuid)` granted to `app_read`, instead of granting `app_read` access to `ingest_events`.
4. **Timeouts** for the ingest pool, set on the connection rather than the role.

This relaxes the "article row is written once" statement in DBA 0001 section 1 to "written once per version" (see ADR-0021). Volumes stay at assignment scale (a 1000-item upload is at most 1000 versions).

## 2. Inputs and current database state
- Schema in `db/migrations/0001_init.sql`: `articles` with `UNIQUE (source, external_id)` and generated `search_vector`; `enrichment_jobs` `UNIQUE (article_id, part, prompt_version)` with state CHECK; `enrichments` with partial unique `enrichments_current_uq (article_id, part) WHERE superseded_at IS NULL`; `derived_values.is_current`.
- All readers query `articles` directly: `src/lib/search/run.ts`, `src/app/api/aggregate/route.ts`, `src/app/api/facets/route.ts`, `src/app/api/articles/[id]/trace/route.ts`, `0002_status_helpers.sql`. Keeping `articles` as the current-version table means none of them change.
- Worker reads text with `SELECT headline, body FROM articles WHERE id = $1` (`src/worker/loop.ts:122`) and writes results in `src/worker/finish.ts`; both must become version-aware.
- `app_ingest`: SELECT, INSERT on `articles`; INSERT on events, quarantine, transformations, jobs; SELECT on `ingest_events` (`0001_init.sql:226-231`). `app_read` has a 2 s statement timeout (`:250`), `app_ingest` has none (sanity F6).
- Extensions present: `pg_trgm`, `unaccent`, `pg_stat_statements`. None added.

## 3. Write budget and capacity model
Versioned write = 1 snapshot insert + 1 `articles` UPDATE (non-HOT: `search_vector` and the GIN and keyset indexes change) + up to 2 job supersedes + 2 job inserts. About 10 statements, a few ms each. At the 1000-item cap, worst case is about 10,000 statements, comfortably under the 60 s request deadline on the `small` profile; to be measured (HP-DB1). `article_versions` growth: one row per changed re-upload, about the size of the article (1 to 5 KB), negligible. If versioned writes ever arrive in the live 800/s path, the UPDATE with GIN maintenance is the part that would not scale; that is out of scope here and noted in section 12.

## 4. Schema
Illustrative sketch, not the final migration.

```sql
-- 0003_article_versions.sql
ALTER TABLE articles
  ADD COLUMN version     integer     NOT NULL DEFAULT 1,
  ADD COLUMN updated_at  timestamptz NOT NULL DEFAULT now();

CREATE TABLE article_versions (
  article_id      bigint      NOT NULL REFERENCES articles(id),
  version         integer     NOT NULL,
  published_at    timestamptz NOT NULL,
  ingested_at     timestamptz NOT NULL,   -- when this version arrived
  language        text        NOT NULL,
  headline        text,
  body            text,
  content_hash    bytea       NOT NULL,
  flags           text[]      NOT NULL DEFAULT '{}',
  superseded_at   timestamptz NOT NULL DEFAULT now(),
  superseded_by_event bigint  REFERENCES ingest_events(id),
  PRIMARY KEY (article_id, version)
);
-- search_text is derived (normaliser) and is not copied: it can be rebuilt from headline/body.

ALTER TABLE ingest_events ADD COLUMN article_version integer;       -- nullable, lineage (P8)
ALTER TABLE enrichment_jobs ADD COLUMN article_version integer NOT NULL DEFAULT 1;
ALTER TABLE enrichments     ADD COLUMN article_version integer NOT NULL DEFAULT 1;

-- unique key now includes the version; state list gains 'superseded_version'
ALTER TABLE enrichment_jobs DROP CONSTRAINT enrichment_jobs_article_id_part_prompt_version_key;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_version_uq
  UNIQUE (article_id, article_version, part, prompt_version);
ALTER TABLE enrichment_jobs DROP CONSTRAINT enrichment_jobs_state_check;
ALTER TABLE enrichment_jobs ADD CONSTRAINT enrichment_jobs_state_check CHECK (state IN
  ('queued','running','succeeded','failed_retryable','deferred_budget',
   'skipped_no_content','dead','superseded_version'));
```

`ingest_new_version(p_article_id bigint, p_event_batch uuid, p_position int, p_expected_hash bytea, p_new ...)`, `SECURITY DEFINER`, `SET search_path = public`, one transaction, in this order:
1. `pg_advisory_xact_lock(hashtext('article'), p_article_id)` (also taken by the worker, section 8).
2. `SELECT ... FROM articles WHERE id = p_article_id FOR UPDATE`; if the stored `content_hash` equals the new hash return `'unchanged'` (a concurrent upload won) and the caller records a `duplicate`.
3. `INSERT INTO article_versions` from the current row (`superseded_at = now()`).
4. `UPDATE articles SET headline, body, language, published_at, content_hash, flags, search_text, search_text_ver, version = version + 1, updated_at = now()`; `ingested_at` is left as the first arrival.
5. Supersede old results: `UPDATE enrichments SET superseded_at = now() WHERE article_id = ... AND superseded_at IS NULL`; `UPDATE derived_values SET is_current = false WHERE article_id = ... AND is_current`.
6. `UPDATE enrichment_jobs SET state = 'superseded_version', reason_code = 'new_version', claim_expires_at = NULL WHERE article_id = ... AND article_version < new AND state IN ('queued','failed_retryable','deferred_budget','running')`. Reserved budget on a superseded `running` job is released by the existing sweeper and finish path; see risk FP-DB3.
7. Insert the new `ingest_transformations` rows (the function receives them as a jsonb array) and the two new `enrichment_jobs` rows for the new version (`skipped_no_content` when there is no text).
8. Insert the `ingest_events` row (`outcome = 'admitted'`, `reason_codes` includes `new_version`, `article_version`).
Returns the new version number. `REVOKE ALL ... FROM PUBLIC; GRANT EXECUTE ... TO app_ingest;`.

Outcome vocabulary stays `admitted | duplicate | quarantined`, so the reconciliation `received = admitted + duplicate + quarantined` is unchanged; versions are told apart by the `new_version` reason code and `article_version`. `ingestOne` flow becomes: insert new article (unchanged) or on conflict compare `content_hash` of the existing row: equal means `duplicate` event as today; different calls `ingest_new_version`.

Confidence and lineage: the superseded enrichments and derived values stay in place (superseded / `is_current = false`) with their `article_version`, so each historic value can be tied to the text it was computed from (P7, P8). `article_versions` plus `ingest_events` give the change history.

JSONB: none added.

Null handling: `article_versions` columns mirror the nullable `articles` text columns; `NOT NULL` only on keys and timestamps. The function treats `headline`/`body` NULL like `ingestOne` does and never concatenates them in SQL.

## 5. Extension plan
No new extension. Core Postgres only (advisory locks, `FOR UPDATE`, SECURITY DEFINER). Existing three unchanged. Package: "core only" for this feature. No vector or queue extension is needed.

## 6. Partitioning and retention
None at this scale (ADR-0001). `article_versions` follows the retention of `articles`; if `articles` is ever partitioned, `article_versions` would be partitioned on `superseded_at`. Quarantine retention ADR-0011 unchanged.

## 7. Index inventory
| Index | Type | Serves | Write cost | Note |
| --- | --- | --- | --- | --- |
| `article_versions` PK `(article_id, version)` | B-tree | Trace page history, function insert | low | covers lookups by article |
| `enrichment_jobs_version_uq` `(article_id, article_version, part, prompt_version)` | B-tree unique | Idempotent job insert | same as old key | replaces the old unique |
| `jobs_article_idx` `(article_id, part)` (existing) | B-tree | `upload_batch_status` join | existing | add `article_version` only if the plan needs it (check with EXPLAIN) |
| `events_batch_idx` `(batch_id, position)` (existing) | B-tree | `upload_batch_status` | existing | the batch query is an index range scan |
No new index on `articles`. Existing GIN, trigram and keyset indexes are updated by the version UPDATE (expected, section 3).

## 8. Write path design
- Per-element transaction as today; versioning runs in the function, one round trip.
- Idempotency: identical content never versions (hash equal). Concurrent identical uploads serialise on the advisory lock plus `FOR UPDATE`; the second gets `'unchanged'`.
- A-B-A edits create versions 2 and 3 even if version 3 equals version 1's text; accepted, history stays truthful.
- Ordering: last upload wins. There is no source-side version signal; `published_at` is not used to refuse a version. UNCONFIRMED, see section 14.
- Worker (small code change, plan task): when it reads text it also reads `version` and carries it; at finish it takes the same advisory lock `pg_advisory_xact_lock(hashtext('article'), article_id)`, re-reads `articles.version`, and if it differs from the job's `article_version` it discards the result and marks the job `superseded_version`. It stores `article_version` on the `enrichments` row. The advisory lock needs no table privilege, so `app_worker` stays read-only on `articles`. The LLM cache lookup (`loop.ts:154`, `input_hash`) is unchanged and still valid across versions because it is keyed by the text hash.
- Durability: unchanged defaults. No synchronous_commit relaxation.
- Ingest pool settings: `statement_timeout = 10s`, `idle_in_transaction_session_timeout = 15s`, `lock_timeout = 5s` set in the pool connection options (`-c`), not by `ALTER ROLE`, so the seed CLI and larger backfills are not constrained. UNCONFIRMED values.

## 9. Search read path and isolation
Unchanged queries. `articles` holds one row per logical article, so results are never duplicated, counts mean articles (not versions), and the keyset indexes are as before. Enrichment-dependent filters (sentiment, topic) correctly stop matching a changed article until its new enrichment lands, because the old `derived_values` are no longer current. The status page's "open jobs" now includes the new version's jobs and ignores `superseded_version` (the existing `open_jobs` predicate lists terminal states explicitly; add `superseded_version` to it in the same migration by replacing `status_snapshot()`).
Isolation: upload writes use the ingest pool inside web; reads use the `app_read` pool; the one-upload-at-a-time limit bounds contention. `app_read` still has the 2 s timeout.

`upload_batch_status(p_batch uuid)` (SECURITY DEFINER, `app_read` EXECUTE): returns, per position, `position`, `outcome`, `reason_codes`, `article_id`, `article_version`, and for admitted rows the state of the `sentiment` and `summary_topics` jobs for the version that event created (join on `article_id` and `article_version`), plus quarantine `status` where relevant. Bounded `LIMIT 5000`. Returns nothing for an unknown batch (the API maps this to 404). No payload text, hashes or field errors are exposed.

Trace page: grant `SELECT ON article_versions TO app_read`; the trace route may list versions (UX decides).

## 10. Operations
- Migration order inside one transaction (all small tables, brief locks): add columns with constant defaults (metadata-only in PG 16), create table, swap constraints, create functions, grants, replace `status_snapshot()`. Replace the CHECK and unique constraints with `NOT VALID` then `VALIDATE CONSTRAINT` if the jobs table is large; at assignment scale a plain swap is fine.
- Rollback (documented in the migration header like 0002): `DROP FUNCTION upload_batch_status(uuid), ingest_new_version(...)`; restore the old state CHECK and unique after setting any `superseded_version` rows to `dead` or deleting the duplicate version rows; versions beyond 1 are lost from `articles` unless copied back from `article_versions` (script: write back the highest `article_versions` row per article only if the rollback is chosen after live use). Dropping the new columns is safe once the code is rolled back. State this limit in the migration header.
- Vacuum: `articles` now sees UPDATEs. Set `autovacuum_vacuum_scale_factor` modestly lower on `articles` (e.g. 0.05, UNCONFIRMED) so dead tuples from versioning and GIN pending-list are cleaned; check `n_dead_tup` after the test run.
- Backups unchanged.
- Idempotent migrations (`IF NOT EXISTS`, `CREATE OR REPLACE`) as in 0001; the DO-block guards constraint swaps.

## 11. Verification plan
| # | Experiment | Threshold |
| --- | --- | --- |
| E1 | Upload sample file, re-upload identical | 0 new versions, 0 new jobs, all `duplicate` |
| E2 | Re-upload with 1 changed body | `articles.version = 2`, 1 `article_versions` row, old enrichments superseded, 2 new jobs, search returns exactly one result with the new text |
| E3 | 1000 changed items in one request on the small profile | request p95 under 60 s; record statements/s (HP-DB1) |
| E4 | Two concurrent uploads of the same changed file | exactly one version bump per article; the other items `duplicate` |
| E5 | Worker finishing a job while a new version lands (inject delay between claim and finish) | result discarded, job `superseded_version`, no current enrichment on the old text |
| E6 | `EXPLAIN` on `upload_batch_status` for a 1000-row batch | index range scan on `events_batch_idx`, under 100 ms |
| E7 | Grants | `app_ingest` cannot `UPDATE articles` directly; `app_read` cannot select `ingest_events` or call `ingest_new_version` |
| E8 | Rollback rehearsal on a copy | old code runs |
First experiment to run: E2 and E5, because they test the one-result-per-article and stale-result guarantees.

## 12. Risks and hot paths
| ID | Entry | Detail |
| --- | --- | --- |
| FP-DB1 | Function not atomic (partial version) | Snapshot written, article not updated, or jobs missing; mitigated by single transaction, tested by fault injection between statements |
| FP-DB2 | Stale enrichment attached to new text | Worker race; mitigated by advisory lock and version check (E5) |
| FP-DB3 | Reserved LLM budget leaked for a `running` job that became superseded | Sweeper/finish must release `reserved_micro` for `superseded_version`; add to tests and to `budget.ts` review |
| FP-DB4 | Search shows old values for filters | Prevented by `is_current = false` in the function; test sentiment/topic filter after a version change |
| FP-DB5 | Last-write-wins replaces newer content with older text | Accepted behaviour (section 8), visible through `article_versions` |
| FP-DB6 | Deadlock between the function and the worker | Same lock order (advisory lock first); `lock_timeout` 5 s |
| FP-DB7 | Dead tuples and GIN pending list after bulk version UPDATE | Autovacuum setting, E3 check |
| HP-DB1 | `ingest_new_version` per changed item | Non-HOT UPDATE plus GIN and trigram maintenance; human reviews the function body and its statement count; measure items/s |
| HP-DB2 | `upload_batch_status` polling | Index range scan; confirm plan and the polling interval |
carma-benchmark candidates: HP-DB1 (conservation: every changed element yields exactly one version, row counts reconcile).

## 13. Handoff
- carma-benchmark: disposable DB through the existing compose `db` profile or a throwaway database named by env; seed = sample file; completeness check = `received = admitted + duplicate + quarantined` from the response and from `ingest_events` by `batch_id`; versions check = `count(article_versions)` equals the number of changed elements; clean-up = drop the throwaway database.
- carma-devops: no new extension or image change; the migration runs with the existing migrator; the ingest pool connection options (section 8); the new web secret mounts (architect handoff).
- carma-backend-testing: E1 to E8, FP-DB1 to FP-DB7, plus the grant matrix.
- carma-telemetry: `article_versions_created_total`, version-conflict (unchanged) counter, `superseded_version` jobs gauge, lock wait time, dead tuples on `articles`.
- carma-plan: tasks: migration 0003, function bodies, `ingestOne` change, worker version check, `status_snapshot()` replacement, `reasons.ts` additions (`new_version`, `superseded_version`).

## 14. Decisions needed and open questions
- UNCONFIRMED: last-upload-wins ordering (no source version signal). Alternative: refuse a version whose `published_at` is older than the stored one and report it as `duplicate`-like with reason `older_than_current`. Needs the user only if content is expected to arrive out of order.
- UNCONFIRMED: ingest pool timeouts (10 s, 15 s, 5 s) and autovacuum factor 0.05.
- Open: should `article_versions` keep `search_text`? Assumed rebuildable, not stored.
- Open: should the trace page and API expose version history in this increment (UX to decide)? The grant is included either way.
