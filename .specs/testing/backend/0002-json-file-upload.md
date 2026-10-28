---
spec: carma-backend-testing
number: 0002
title: Test plan for the JSON upload and article versioning
status: draft
date: 2026-10-24
feature: json-file-upload
inputs: [.specs/architect/0002-json-file-upload.md, .specs/data/sanitization/0002-json-file-upload.md, .specs/data/dba/0002-json-file-upload.md, .specs/telemetry/0002-json-file-upload.md, .specs/devops/0002-json-file-upload.md, .specs/testing/backend/0001-media-signal-service.md, .specs/architect/adrs/0017-test-tooling-and-tiers.md]
principles: [P2, P3, P6, P8]
supersedes: null
---

# 0002 Test plan for the JSON upload and article versioning

## 1. Summary and scope
This plan covers only what is new: the upload route and gate, per-item reporting, article versioning (ADR-0021), the worker's version guard, the batch status function, grants, and the upload page. Tests already in spec 0001 (per-article validation, markup reduction, worker retry/breaker/budget, search) are reused by running the same fixtures through the upload path, not rewritten. Tiers follow ADR-0017: MUST on every commit, SHOULD nightly or before release, COULD on demand.

The central invariant: **received = admitted + duplicate + quarantined for every upload, and a changed re-submission yields exactly one new version with no stale enrichment.**

## 2. Test environment and tooling
Existing: Vitest for `tests/unit` and `tests/integration` (`vitest.config.ts`), real PostgreSQL via `tests/harness/db.ts`, provider fakes in `tests/fakes/providers.ts`, article fixtures in `tests/fixtures/articles.ts`, Playwright in `tests/e2e/smoke.spec.ts`. Additions:
- `tests/harness/upload.ts`: builds multipart and JSON bodies, token header, and a helper that calls the route handler function directly (unit/integration) or the running stack (e2e).
- `tests/fixtures/upload-files.ts`: file-level fixtures (section 8).
- A fault proxy is not needed; DB faults use the harness (terminate backend via `pg_terminate_backend`, stop container in the Compose tier).
- Route handler must be importable and callable with a `Request` (design requirement for the plan: keep the handler thin, logic in `src/lib/upload/*`).

## 3. Integrity invariants and tests
| ID | Invariant | Test | Tier |
| --- | --- | --- | --- |
| I1 Conservation | Response `received` equals count of `ingest_events` for `batch_id`, and equals admitted + duplicate + quarantined; `reconciled` true | `tests/integration/upload-conservation.test.ts`: sample file, mixed good/bad file (fixtures from 0001), file with every null-matrix variant | MUST |
| I2 Idempotency | Same file twice: second run all `duplicate`, zero new `articles`, zero new `enrichment_jobs` | `upload-idempotent.test.ts`; concurrent twice (`Promise.all`) gives exactly one admitted per item | MUST |
| I3 Versioning | Changed body: `articles.version = 2`, one `article_versions` row holding v1 text/hash, `ingest_events` reason `new_version` with `article_version = 2`, v1 enrichments superseded, `derived_values.is_current = false` for v1, two new jobs for v2 | `upload-version.test.ts` (DBA E2) | MUST |
| I4 One result per article | After a version change, search returns one hit with v2 text; sentiment/topic filters exclude the article until v2 is enriched | `upload-version-search.test.ts` | MUST |
| I5 Unchanged content | Same text re-sent: no version, `unchanged`/`duplicate` | covered in I2; plus A-B-A: v3 created equal to v1 text | SHOULD |
| I6 Fidelity | Arabic, Chinese, emoji, bidi/zero-width, NUL, lone surrogates through the upload: stored text equals `reduceMarkup`+`repairText` of the input; hash of stored text matches `content_hash`; transformations recorded | reuse 0001 cases via `upload-fidelity.test.ts` | MUST |
| I7 Lineage | Every admitted event has `article_id`; every article has event(s) by `batch_id`; `payload_sha256` equals sha256 of the element JSON | `upload-lineage.test.ts` | SHOULD |
| I8 Batch kind | Uploaded rows have `batch_kind = 'backfill'`; live freshness watermark unchanged | `upload-batch-kind.test.ts` | MUST |
| I9 Ledger | After a worker finishes jobs for an upload, no job remains `running`; no `succeeded` job lacks an enrichment | reuse worker integration helpers | SHOULD |
| I10 Confidence | A v2 article shows "no confidence"/not enriched, never the v1 value, until v2 finishes | part of I3/I4 (asserts via `/api/articles/[id]` data function) | MUST |

## 4. Failure-point coverage matrix
| FP | Test (file) | Technique and expected outcome | Tier |
| --- | --- | --- | --- |
| FP-1 not JSON / not array | `tests/unit/upload-gate.test.ts` | table of bodies; 400 with `not_an_array`/`invalid_json`; `ingest_events` count unchanged | MUST |
| FP-2 size/count | `upload-gate.test.ts` | at cap OK, +1 byte 413, 1000 items OK, 1001 422, lying `Content-Length`, chunked without length | MUST |
| FP-3 bad elements | `upload-conservation` | each quarantined with reason; others continue | MUST |
| FP-4 DB drop mid-file | `tests/integration/upload-fault.test.ts` | terminate backends after N items: 503 `db_unavailable`; re-upload reconciles; no duplicate articles | MUST |
| FP-5 client abort | `upload-fault.test.ts` (AbortController at item k) and e2e | server completes or stops cleanly; `GET batch` shows true counts; re-upload safe | SHOULD |
| FP-6 concurrent same file | `upload-idempotent` | exactly one version/insert per item | MUST |
| FP-7 LLM budget | `upload-budget.test.ts` | 1000-item file with tiny budget: jobs `deferred_budget`, none dropped, spend <= cap | SHOULD |
| FP-8 starvation | e2e/nightly `upload-search-mixed` | search p95 during a 1000-item upload stays within 2x idle (proposed) | SHOULD |
| FP-9 token | `upload-auth.test.ts` | none/wrong/short/long/equal-prefix tokens: 401; constant-time compare helper unit-tested for equal-length; token absent from logs (pino capture) and response | MUST |
| FP-10 hostile text | `upload-sanity.test.ts` | section 9 inputs; stored intact, flagged, never rendered | MUST |
| FP-11 live clock | `upload-batch-kind` | see I8 | MUST |
| FP-12 reconcile mismatch | `upload-reconcile.test.ts` | inject a failing recorder (fake `recordItemError` returning false): response must be 500 with mismatch counter, never 200 with wrong counts | MUST |
| FP-D1 body bomb | `upload-gate` + Compose tier | 6 MiB, 25 MiB streamed, slow-loris-ish partial body: rejected on bytes read; memory stays under limit | SHOULD |
| FP-D3 no partial rows on whole-file reject | `upload-gate` | row counts unchanged for every rejected body | MUST |
| FP-D4 ambiguous counts | `upload-conservation` | report uses three disjoint outcomes; `errors` never added | MUST |
| FP-D5 changed content | I3 | see above | MUST |
| FP-D7 encodings | `upload-encoding.test.ts` | UTF-16, Latin-1, Windows-1256 bytes, BOM: strict UTF-8 only; BOM stripped; message says re-save | MUST |
| FP-DB1 function atomicity | `version-atomic.test.ts` | fault between statements (`RAISE` via test hook / terminate): all-or-nothing | MUST |
| FP-DB2 stale enrichment | `version-worker-race.test.ts` | claim a v1 job, upload v2, finish v1: result discarded, job `superseded_version`, no current v1 enrichment (DBA E5) | MUST |
| FP-DB3 budget leak | `version-budget.test.ts` | `running` job reserved budget, then superseded: `reserved_micro` returns to 0 after finish/sweep | MUST |
| FP-DB4 filters stale | I4 | | MUST |
| FP-DB6 deadlock | `version-lock.test.ts` | concurrent function + worker finish on same article, 50 iterations: no deadlock, `lock_timeout` not hit | SHOULD |
| FP-DB7 bloat | nightly soak slice | after 200 version updates, `n_dead_tup` reclaimed by autovacuum | COULD |
| FP-V1..V5 | Compose tier (devops 0002 section 9) | executed by the deployment suite, not duplicated here | SHOULD |

## 5. Soft requirements
| Claim | Threshold | Method | Evidence | Status |
| --- | --- | --- | --- | --- |
| 1000-item upload completes | request p95 < 30 s, hard limit 60 s on the small DB profile | `.benchmarks/json-file-upload` (carma-benchmark) and a nightly run, 5 repetitions | durations, items/s, statements/s | proposed |
| Upload does not starve search | search p95 under upload < 2x idle | mixed run: 20 searches/s while one upload runs | percentile table | proposed |
| Memory | web peak RSS < 80% of limit at cap-size file | `docker stats` sampling in Compose tier | peak RSS | proposed |
| Enrichment catches up | 1000 articles reach terminal state within `ceil(2000 jobs / (RPM)))` plus margin using mock provider | worker with mock latency | time to terminal | proposed |
| Live freshness | not applicable to uploads (backfill); the 15-minute target is unaffected | assert live watermark unchanged (I8) | test result | agreed target, excluded |
Environment (hardware, DB profile, versions, row counts) is recorded in every result file.

## 6. Hot path measurements
| HP | Measurement | Human inspection trigger |
| --- | --- | --- |
| HP-1 / HP-D1 `ingestOne` loop | items/s and event-loop lag for 1000 items, with `EXPLAIN` for the 4 statements | lag > 100 ms sustained, or > 20 ms/item |
| HP-2 / HP-D2 parse and buffer | peak RSS and parse time for 5 MiB (ASCII, Arabic, Chinese) | peak > 150 MB over baseline |
| HP-3 / HP-DB2 batch status | `EXPLAIN (ANALYZE)` for 1000-row batch, polling at 3 s with 5 clients | seq scan, or > 100 ms |
| HP-DB1 `ingest_new_version` | statements and ms per version; 1000 versions in one request | > 30 ms per version |

## 7. Load generator and test data
Extend the existing fixtures: a seeded generator (`tests/fixtures/upload-files.ts`) producing N articles with a language mix (en/ar/zh), size distribution (200 B to 50 KB), a controllable fraction of invalid elements, duplicates, and "changed" variants of previously generated ids (same `source`+`id`, new body). Seed value printed in failures. Synthetic data only (policy default).

## 8. Resilience and negative tests
| Dependency | Fault | Expected | Evidence | Tier |
| --- | --- | --- | --- | --- |
| Postgres (ingest pool) | connection refused at start | 503 `db_unavailable`, `Retry-After`, no rows | response, `mss_upload_rejected_total` | MUST |
| Postgres | backend terminated mid-file | as FP-4 | batch status vs response | MUST |
| Postgres | `statement_timeout` hit on one item (slow query injected with `pg_sleep` trigger in test schema) | that item recorded `ingest_error` quarantine or request 504 with counts; no hang past deadline | duration < deadline | SHOULD |
| Postgres | pool exhausted (second upload) | 429 `upload_busy` | status | MUST |
| LLM provider (via worker) | outage after upload | jobs retry/dead per 0001; breaker open; articles searchable, "enrichment unavailable"; upload report shows state | state table | SHOULD (reuse fakes) |
| Client | disconnect, slow body | see FP-5, FP-D1 | | SHOULD |
Negative input catalogue (file level): from sanity spec section 11 verbatim, implemented as a table-driven test in `upload-gate.test.ts`: no token, wrong token, wrong type, empty, whitespace, BOM, truncated, object/string/null/number top level, 1001 items, depth 9, 100k-deep brackets, 5 MiB single string, NaN tokens, multipart with 2 files, giant non-file field, hostile filename. Element-level: the 0001 negative matrix replayed through the route. Game day (COULD, on a disposable stack): kill `web` during a 1000-item upload, then `db` during an upload with the worker running; hypothesis: after recovery and one re-upload, counts reconcile and no article is double-versioned.

## 9. Security and sanity tests
Assigned from data-sanity 0002 section 11: auth and gate cases (MUST, unit), element hostile content through the route (MUST, integration), prompt-injection strings per language flagged not dropped (SHOULD), XSS: batch report and article page render reason codes and hostile `external_id`/`source` as text (Playwright, SHOULD), token and file text absent from logs and `/api/metrics` (MUST), grants matrix (`app_ingest` cannot UPDATE `articles` directly, `app_read` cannot read `ingest_events` or execute `ingest_new_version`; `app_worker` cannot execute it) in `tests/integration/grants.test.ts` (MUST).

## 10. Test levels and when they run
- Every commit (MUST): unit gate/auth/encoding/redaction tests; integration I1-I4, I6, I8, FP-3, FP-4, FP-6, FP-9, FP-10, FP-12, FP-DB1-DB3, grants. Target < 2 minutes added to the suite.
- Nightly / pre-release (SHOULD): FP-5, FP-7, FP-8, FP-DB6, XSS e2e, 1000-item performance run, memory sample, Compose deployment suite.
- On demand (COULD): game day, soak with version churn.
Playwright e2e: one happy path (`tests/e2e/upload.spec.ts`: upload sample file, see summary and progress reach done, click an article) and one rejection path (wrong token).

## 11. Exit criteria and reporting
Done when: all MUST tests pass; I1 holds across every scenario (assert in a shared `afterEach` helper that reconciles the last batch); each FP row has a passing test or a recorded gap; performance claims have 5-run percentile results stored under `reports/json-file-upload/` with environment details; a failed MUST is a blocker; a failed SHOULD is a risk accepted by the user (named in the report).

## 12. Gaps, risks and open questions
- Gap: no automated test of a real reverse proxy body limit (none exists); revisit if one is added.
- Gap: real LLM providers are not exercised (fakes only), as in 0001.
- Risk: the route must be callable without a running Next server for the integration tier; if Next's route handler cannot be invoked directly in Vitest, test through the extracted `src/lib/upload` function plus Playwright for the HTTP layer.
- Open: acceptable search degradation during upload (2x idle is a proposal).
- UNCONFIRMED thresholds are labelled `proposed` above.

## 13. Handoff
carma-plan schedules: (1) harness additions (`upload.ts`, fixtures, shared reconcile helper), (2) MUST integration suites alongside the code they test (per task), (3) grants and fault tests with the migration, (4) e2e and Compose suite after the UI, (5) benchmark and nightly performance run last (carma-benchmark for HP-1 and HP-DB1).
