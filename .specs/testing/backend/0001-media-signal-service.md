---
spec: carma-backend-testing
number: 0001
title: Backend test plan for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/search/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
  - .specs/data/dba/0001-media-signal-service.md
  - .specs/telemetry/0001-media-signal-service.md
  - .specs/ux/0001-media-signal-service.md
  - .specs/devops/0001-media-signal-service.md
principles: [P2, P3, P5, P6, P7, P8]
supersedes: null
---

# Backend test plan

## 1. Summary and scope

This plan proves five things, in this order of importance:

1. **No article is lost or silently changed** between file, ledger, database, search and enrichment (conservation, fidelity, idempotency).
2. **Search and aggregates are correct** (golden queries, keyset walk, known-answer aggregates, drill-through equality).
3. **Hostile and malformed input is handled safely** (SQL, XSS, prompt injection, Unicode, nulls).
4. **Dependency failures behave as designed** (retries, breakers, budgets, dead-letter, recovery), using fake providers.
5. **Soft requirements are measured** on a synthetic 1 M-row table, with the extrapolation to 800/s labelled as an extrapolation, not a result.

Scope follows ADR-0001: 20 sample articles plus approved synthetic fixtures; the 50,000-a-day case is run at its real rate and at 10x; the 800/s target and the 15-minute freshness SLO are **not proven**, only supported by measurements on a smaller scale. The deployment tests T1 to T20 stay in the devops spec; this plan shares its Compose `test` profile and does not repeat them.

Every failure point and hot path in the five specs maps to a test or a documented gap (section 4 and 6).

## 2. Test environment and tooling

Current state: greenfield, no tests, no runner, no CI, no `.benchmarks/` directory (checked 2026-10-24).

Proposed (decision TS1; Vitest + Playwright recommended):

| Need | Tool | Why |
| --- | --- | --- |
| Unit and integration | Vitest (TypeScript native, fast, fake timers) | One toolchain with Next.js; `vi.useFakeTimers` for backoff and breaker |
| Component render / XSS | React Testing Library + jsdom | Fast check that article text renders as text |
| Browser end to end | Playwright | Real browser for XSS execution, bidi, stale responses, axe checks |
| Accessibility | `@axe-core/playwright` | Quick automated pass |
| Fake providers | Small Node HTTP servers in `tests/fakes/` (jev-compatible and OpenAI-compatible), scriptable per test | Deterministic faults, request recording |
| Real PostgreSQL | The Compose `db`, one disposable database per suite created `FROM TEMPLATE mss_template` (a migrated template database) | Real locking, indexes and plans; fast isolation |
| Load generator | `tools/gen` (seeded), also importable by carma-benchmark | One generator, same numbers |
| Secret scan | gitleaks | Devops T12 |

**Compose `test` profile (from the devops spec):** a `test` service built from a Dockerfile target `test` (includes dev dependencies; the runtime image does not), running against the same `db`, with `ENRICHMENT_MODE=mock` by default and fake providers started in-process by the tests. A `fakes` service exists only for the few container-level checks that need a real worker pointed at fake URLs through `JEV_BASE_URL` and `OPENAI_BASE_URL`. Real providers are used only by the opt-in smoke test R-1.

**Seams the code must provide** (requirements for the plan, because tests depend on them):

- A `Clock` object (now, sleep) injected into retry, breaker, budget day, sweeper and worker loop, so time-dependent tests run instantly with fake timers. SQL keeps `now()`; tests that need DB time set `claim_expires_at`/`next_attempt_at` directly in rows instead of faking the database clock.
- Provider base URLs, model ids, prices and mock latency (`MOCK_LATENCY_MS`) are configuration.
- The worker loop is importable and runnable in-process (`runWorkerOnce`, `runWorkerUntilIdle`) as well as as a process.
- Parser, compiler, sanitiser, normaliser, validator, prompt builder and classifier are pure modules with no I/O (also the architect's benchmarkability seam).
- Counters for reconciliation are readable from the database (ledger queries) so tests and carma-benchmark need no extra instrumentation.

**Test data policy (decision TS3):** synthetic and the provided sample only; no real articles; no keys in any test except R-1.

## 3. Integrity invariants and tests

### 3.1 Invariants

| ID | Invariant | Check (run after every scenario by `assertInvariants(db)`) |
| --- | --- | --- |
| INV-1 | Conservation at ingest | For each batch: `received = admitted + quarantined + duplicate` from `ingest_events`; `count(articles)` equals the sum of admitted events |
| INV-2 | Every article has jobs | Every article has exactly one job per part (state may be `skipped_no_content`); no job without an article |
| INV-3 | Jobs reconcile | Jobs by state sum to total jobs; no `running` job past `claim_expires_at` once the sweeper has run |
| INV-4 | Budget reconciles | `reserved_micro` equals the sum of `reserved_micro` of `running` jobs; `reserved + spent <= cap` always |
| INV-5 | One current result | At most one non-superseded `enrichments` row per (article, part); every `derived_values` row belongs to an enrichment and every confidence satisfies the constraint |
| INV-6 | Fidelity | Stored text equals the independently computed reduction of the input; `search_text` equals `normalise(headline + ' ' + body)` at `search_text_ver` |
| INV-7 | Transformations recorded | Every article whose reduction changed the text has a matching `ingest_transformations` row |
| INV-8 | No loss by enrichment failure | An article whose enrichment is `dead`, `deferred_budget` or `skipped` is still returned by list and search and counted in aggregates (under `not_enriched`) |
| INV-9 | List and aggregate agree | For any filter set: `sum(buckets) = total` (except topic split) and `list total = bar count` |
| INV-10 | No secret or content in logs | After a full run: no headline, body, summary, prompt, key or password string in captured logs |

### 3.2 Integrity tests

| ID | Test | Level |
| --- | --- | --- |
| I-CONS-1 | Load the 20 samples: 20 admitted, 0 quarantined; flags exactly: id 6 `markup_reduced`, id 18 `markup_reduced`, id 17 `headline_missing`; INV-1 to INV-7 | Integration |
| I-CONS-2 | Load the null-matrix set (every cell of data-sanity section 4 as an item): each lands in the specified outcome with the specified reason code; totals balance | Integration |
| I-CONS-3 | Mixed batch of valid, quarantined and duplicate items (interleaved); INV-1 | Integration |
| I-IDEM-1 | Load the sample twice: second load adds 0 articles, 20 `duplicate` events, no new jobs | Integration |
| I-IDEM-2 | Same content under a new id: admitted, flagged `duplicate_content`, enrichment served from cache (`origin = cache`, cost 0) | Integration |
| I-IDEM-3 | Redelivery during a batch failure: failed batch retried row by row; only the bad row is quarantined | Integration |
| I-IDEM-4 | Out-of-order arrival: articles with older `published_at` loaded after newer ones appear in correct list order | Integration |
| I-FID-1 | Round trips en, ar, zh, mixed script, emoji, combining marks, 1 MiB body: stored equals expected; searchable by a planted token; id 8 and 9 byte-identical to input | Integration |
| I-FID-2 | `search_text` rebuild (`backfill-search-text`) is idempotent; after a simulated normaliser version bump only old rows change; search results unchanged | Integration |
| I-FID-3 | NUL, lone surrogate, C0 controls, bidi controls, zero-width characters: repaired as specified, counted in transformations, brand names split by zero-width characters still match | Integration |
| I-CONF-1 | Confidence constraint: partial confidence rejected; `none` origin with NULL accepted; `scale_min >= scale_max` rejected; norm outside 0..100 rejected | Integration |
| U-CONF-1 | Normalisation: min, max, midpoint, below-min, above-max, min = max, inverted range, NaN, infinity; jev concentration (p_max - 1/n)/(1 - 1/n) for n = 4 | Unit |
| I-CONF-2 | Mock output stored with origin `mock` and shown as such by the API; sentiment from jev stores class probabilities summing to 1 | Integration |
| I-SUP-1 | Re-enrichment: supersede in one transaction; the partial unique index rejects two current rows; `is_current` flips with it | Integration |

## 4. Failure-point coverage matrix

Techniques: U unit, I integration (real Postgres), E browser/component, F fault injection, M measurement, D deployment test (devops T-n), Doc documented gap.

| FP | Test IDs | Expected outcome |
| --- | --- | --- |
| FP-1 | U-PARSE-6, U-PARSE-7, U-PARSE-8 (fuzz) | Typed error with position, never an unhandled exception or 500; caps enforced |
| FP-2 | U-PARSE-1, I-SEARCH-6 (G6, G7) | Lowercase `and`/`or`/`not` are terms; `AND` alone is an error |
| FP-3 | U-PARSE-8, U-PARSE-9, U-PARSE-10, I-SQL-1 | No user substring in SQL text; parameters only; injection strings return results or errors, never DB errors |
| FP-4 | I-SEARCH-8 (G9), I-SUBSTR-2 | `科技` and `海外` find id 9 |
| FP-5 | U-NORM-2, I-SEARCH-7 (G8) | `عقارات` finds id 8; diacritic/alef variants match |
| FP-6 | U-SAN-1 to U-SAN-8, E-XSS-1, E-XSS-2 | Ids 6 and 18 stored as reduced text; nothing executes; transformation recorded |
| FP-7 | I-CONS-1, I-CONS-2, I-NULL-1 | Id 17 admitted with flag; null matrix outcomes; no row lost |
| FP-8 | I-IDEM-1, I-IDEM-3 | No duplicates; duplicate events recorded |
| FP-9 | F-WK-1, I-SWEEP-1 | Killed worker's job returns after visibility timeout; budget released; INV-3, INV-4 |
| FP-10 | U-VALOUT-1 to U-VALOUT-12, F-JEV-9, F-OAI-9 | Invalid outputs rejected with reason, retried at most twice, then `dead` with raw output kept |
| FP-11 | U-PROMPT-1 to U-PROMPT-6, U-INJ-1, F-INJ-1 | Fenced prompt, nonce stripped, flag set, `trust = low`, validator holds, article still counted |
| FP-12 | F-JEV-*, F-OAI-*, F-BRK-1 to F-BRK-5 | Retries per policy; breaker opens; jobs wait, not die; recovery drains |
| FP-13 | I-COST-1 to I-COST-4, U-PROMPT-4, I-IDEM-2 | Token cap, cache hit, attempts cap, no spend on cache hits |
| FP-14 | I-BUDGET-1, I-BUDGET-2, M-BUDGET | 16 concurrent reservations never exceed cap |
| FP-15 | I-KEYSET-1 to I-KEYSET-5, U-CURSOR-1 | Every row exactly once including ties; bad cursors rejected |
| FP-16 | I-AGG-1 to I-AGG-8, I-DRILL-1 | Known answers; conservation; zero buckets; UTC edges |
| FP-17 | I-CONF-2, E-STATES-5 | Origin `mock` stored and displayed |
| FP-18 | I-COVER-1, E-STATES-3 | "Not yet enriched" state and counts correct |
| FP-S1 | I-SUBSTR-1, I-SEARCH-7 | Arabic prefix case found |
| FP-S2 | M-TRGM-1 (E1), M-TRGM-2 (E4), I-SUBSTR-3 | Trigram extraction recorded; 3+ char term uses the index; 2-char term correct but may scan |
| FP-S3 | I-NOT-1, I-NULL-1 | `NOT` never loses rows; id 17 present in complements |
| FP-S4 | U-PARSE-2, E-STATES-1 | Echo makes implicit `AND` explicit |
| FP-S5 | I-COVER-2, E-STATES-3 | Exclusion count reported |
| FP-S6 | I-DRILL-1, I-AGG-4 | Shared filter builder: list total equals bar |
| FP-S7 | I-AGG-6 | Topic split labelled multi-label; total still distinct articles |
| FP-S8 | I-AGG-5 | UTC Monday boundary pair lands in different weeks |
| FP-S9 | I-API-1 | No markup in any API response from highlighting; none implemented |
| FP-S10 | U-NORM-1, U-NORM-5 | Same module at index and query; normalise is idempotent |
| FP-S11 | I-SEARCH-12 (differential oracle) | Oracle and Postgres agree on golden and random queries, or each difference is explained |
| FP-S12 | U-PARSE-5, I-API-2 | Prefix under 2 characters rejected; wildcard count capped |
| FP-S13 | I-KEYSET-4 | Cursor bound to filters; reuse rejected |
| FP-D1 | U-SAN-1 to U-SAN-4, I-FID-1 | Ar/zh text unchanged by reduction; `a < b` kept |
| FP-D2 | U-SAN-6, F-INJ-2 | Hidden text dropped and flagged, never reaches a prompt |
| FP-D3 | I-CONS-2, I-CONS-3, I-QUAR-1 | `received = admitted + quarantined + duplicate` always |
| FP-D4 | I-NULL-2, U-VAL-* | `und` recorded as a transformation; no other silent defaults |
| FP-D5 | I-CONS-2 | Landing tables accept malformed items |
| FP-D6 | I-NULL-1 | NULL headline does not erase body from `search_text` |
| FP-D7 | I-SQL-2 (static check) | No interpolation in query calls (lint plus grep test) |
| FP-D8 | E-XSS-1, lint | No raw HTML sink in source |
| FP-D9 | E-XSS-3 | Summary containing `<img onerror>` renders as text |
| FP-D10 | U-PROMPT-2, F-INJ-3 | Forged closing delimiter is removed or inert |
| FP-D11 | F-OAI-9, I-COST-3 | At most 2 attempts for invalid output |
| FP-D12 | I-BUDGET-3, I-SWEEP-2 | Leaked reservation released; INV-4 |
| FP-D13 | D-T12, I-LOGS-1, U-LOG-1 | No key in bundle, logs or non-worker containers |
| FP-D14 | E-STATES-6, U-CONF-1 | UI text states jev confidence is decisiveness and LLM confidence is self-reported |
| FP-D15 | I-CONF-2, E-STATES-5 | Mock labelled |
| FP-D16 | I-QUAR-1, I-STATUS-1 | Quarantine counts and age exposed |
| FP-DB1 | I-MIG-1, I-MIG-2 | Re-run no-op; edited checksum detected; advisory lock |
| FP-DB2 | I-MIG-3 | Without `pg_trgm`: migration succeeds, `trgm_index=off`, substring search still correct |
| FP-DB3 | I-ROLE-1 (D-T13) | `app_read` cannot write or read quarantine; `app_worker` cannot run DDL |
| FP-DB4 | I-FINISH-1, F-WK-2 | Stale worker result does not create a second current row or double-settle |
| FP-DB5 | I-SWEEP-2, I-BUDGET-3 | Reservation released |
| FP-DB6 | I-FID-2 | Version bump found and rebuilt |
| FP-DB7 | I-MIG-4 | Generated column exists after migration 1; later index migration is concurrent on a populated table |
| FP-DB8 | M-BUDGET | Hot-row throughput measured and reported (growth caveat) |
| FP-DB9 | M-THRU | Latency spikes from GIN pending list observed in insert timing |
| FP-DB10 | I-AGG-5 | See FP-S8 |
| FP-DB11 | I-QUAR-3 | `payload_text` NULLed after retention; hash and reasons remain |
| FP-V1 | D-T9 | Recovery after kill (single host stays a documented risk) |
| FP-V2 | D-T1, D-T7 | No migrate against half-initialised DB |
| FP-V3 | D-T8, I-MIG-5 | Clear message on secrets/data mismatch |
| FP-V4 | D-T12 | Secret scan clean |
| FP-V5 | D-T12 | Keys only in worker; bundle clean |
| FP-V6 | U-CFG-1 to U-CFG-6, D-T6 | Clear message, container ends `exited` |
| FP-V7 | D-T7 | Everything idempotent in migrator |
| FP-V8 | D-T19 | `.gitattributes` enforced |
| FP-V9 | D-T18 | Build works without DB |
| FP-V10 | D-T2 | Static asset fetched in smoke |
| FP-V11 | D-T9 | No OOM kill under the mixed load |
| FP-V12 | Doc | Profile off by default; compare M-LAT with and without (SHOULD) |
| FP-V13 | I-CFG-LINT | A test fails the build if any image tag is `latest` or missing a minor version in `compose.yaml`/`Dockerfile` |
| FP-V14 | U-CLOCK-1 | Clock difference over 5 s produces the warning |
| FP-V15 | Doc / F-DISK-1 (cut line) | Documented; optional tmpfs test |
| FP-V16 | D-T1 | `--wait` behaviour verified |
| FP-V17 | D-T1 | Starts on the target engine; fallback documented |

Gaps accepted with reason: FP-V1 (single host is a deployment property), FP-V12 and FP-V15 (environment-dependent, documented), FP-V13 covered by a static test only.

## 5. Soft requirements: profile and prove

Agreed target: the 15-minute `published_at` to user figure. Everything else is **proposed**. The test environment (hardware, Docker Desktop on WSL2 or Linux, settings, versions, row counts) is recorded with every number. Docker Desktop on Windows virtualises storage; numbers from it are valid as relative comparisons, not as absolute capacity.

| ID | Claim | Threshold | Method | Load profile | Evidence |
| --- | --- | --- | --- | --- | --- |
| M-FRESH-1 | A live-batch article is searchable at commit | Search finds a planted token within 1 s after the loader's commit, 100% (structural; proposed) | Insert 1,000 articles with unique tokens, poll search | Steady 6/s | p50/p95/p99/max visibility delay |
| M-FRESH-2 | Time to enriched in mock mode | p95 under 5 min at 10x peak (proposed, SLI-4) | Fake providers with log-normal latency (median 800 ms, p99 5 s), concurrency 4 | 0.58/s for 30 min, then 6/s for 10 min | Histogram from `enrichments.created_at - articles.ingested_at` |
| M-FRESH-3 | The 15-minute target for live mentions | Share within 15 min = 100% at 6/s with fake providers (agreed target, small scale only) | Same run; capture lag is 0 in the test | As above | Share and max; caveat: capture lag from real feeds is not tested |
| M-THRU-1 | Insert rate with the full index set | Report rows/s at batch 100 and 1,000; no threshold | 100,000 rows from the generator | Single writer | Rows/s, WAL bytes per row, index sizes; extrapolation to 800/s with caveats |
| M-THRU-2 | Insert rate without the trigram index | Report | Same | Same | Shows the trigram cost (HP-DB1) |
| M-LAT-1 | Interface latency on 1 M rows | Search p95 < 500 ms, list p95 < 200 ms, aggregate p95 < 500 ms (proposed SLI-7) | 200 queries from a mix: golden-style queries, keyset pages at depths 1, 100, 10,000, filters, aggregates; concurrency 4 and 16 | Idle DB | p50/p95/p99 per endpoint |
| M-KEYSET-1 | Keyset cost is flat by depth | Page 1 and page 10,000 within 20% | `EXPLAIN (ANALYZE, BUFFERS)` and timing; assert no `Sort` node | 1 M rows | Plans saved |
| M-AGG-1 | Aggregate speed and plan | Under 500 ms for every filter combination | `EXPLAIN` and timing for weekly, monthly, each `group_by` | 1 M rows | Plans, timings |
| M-TRGM-1 | `pg_trgm` behaviour on non-ASCII (E1) | Recorded, no threshold | `show_trgm` for Chinese, Arabic, 2-char and Latin strings; `lc_ctype`; encoding | n/a | Output in the report; decides the image locale |
| M-TRGM-2 | Trigram index use (E4) | 3+ character terms use the index; 2-character terms may scan but stay correct | `EXPLAIN` with `enable_seqscan=off`; result equality between plans | 1 M rows | Plans, equality check |
| M-CLAIM-1 | Claim contention (E6) | Zero double claims; report claims/s | 1, 2, 4, 8 claimers on 100,000 jobs | n/a | Claims/s per worker count |
| M-BUDGET | Reservation throughput and correctness (E7) | Never over cap; report tx/s | 16 concurrent reservers | n/a | Final ledger, tx/s |
| M-MIXED-1 | Reads and writes coexist | Search p95 within 2x idle while ingesting at 6/s and at max loader rate (proposed) | Run M-LAT-1 during ingest | Mixed | Ratio |
| M-RECOVER-1 | Backlog then recovery | Drain rate exceeds arrival rate; no second failure | Pause worker, enqueue 20,000 jobs, resume at 0.58/s arrivals | Backlog | Time to drain, error counts |
| M-SIZE-1 | Capacity model check | Report bytes per article for each table and index | `pg_total_relation_size` after 1 M rows | 1 M rows | Replaces DBA assumption of 10 to 14 KB |
| M-SOAK-1 | No leaks at assignment rate | Flat memory in `web` and `worker`, stable connection count, dead tuples bounded on `enrichment_jobs` | 30 minutes at 6/s (`docker stats`, `pg_stat_user_tables`) | 6/s | Charts or tables |
| M-COST-1 | Cost model against recorded usage | Recorded tokens within 25% of prompt estimates; cost per article recorded | Real-provider smoke R-1 on the 20 samples (opt-in) | 20 articles | Tokens, cost, per-provider totals; feeds the README cost analysis |

**Not run (documented):** a multi-hour soak and any 800/s run. The README states the extrapolation method and its limits: 1 M rows is 21 minutes of 800/s traffic, index behaviour and autovacuum at tens of millions of rows per day are untested.

## 6. Hot path measurements

| HP | Measurement | Human-inspection trigger |
| --- | --- | --- |
| HP-1 / HP-S1 (parser, compiler) | U-PARSE-8 fuzz (100,000 random strings, no unhandled exceptions, no user substring in SQL); parse time vs length | Any parse over 5 ms for a 500-char query, or any fuzz failure |
| HP-2 / HP-S2 / HP-DB2 (search SQL) | M-LAT-1, M-TRGM-2: `EXPLAIN` for G1, G3 and a mixed English+Chinese query | Sequential scan at 1 M rows for an FTS-only query; `BitmapOr` missing for mixed |
| HP-3 / HP-DB3 (keyset) | M-KEYSET-1 | Sort node present or depth-dependent time |
| HP-4 / HP-S3 / HP-DB6 (aggregate) | M-AGG-1 | Plan scans more than the date-ranged slice |
| HP-5 / HP-D1 (sanitiser) | U-SAN-8 (1 MiB `<` string, deeply nested tags) timing | Over 200 ms or non-linear growth |
| HP-6 / HP-DB4 (claim, finish) | M-CLAIM-1 | Double claim, or claims/s falling with more workers |
| HP-7 / HP-D3 (provider call, prompt) | M-COST-1, M-FRESH-2; prompt snapshot test U-PROMPT-7 | Prompt diff in review; tokens over cap |
| HP-D2 / HP-DB5 (budget reservation) | M-BUDGET | Any over-cap state |
| HP-D4 (injection heuristic) | U-INJ-3 timing on pathological repeated strings | Non-linear time |
| HP-DB1 (batch insert) | M-THRU-1, M-THRU-2 | Insert rate falling over a run (pending list flush) |
| HP-V1 (cold build) | D-T1 time | Over 5 minutes |
| HP-V2 (migrate no-op) | I-MIG-2 timing | Over 2 s when up to date |
| HP-V3 (memory vs limit) | M-SOAK-1 `docker stats` | Database above 80% of its limit |

## 7. Load generator and test data specification

`tools/gen` (TypeScript, no I/O dependencies, importable by tests and by carma-benchmark):

- **Determinism:** seeded PRNG (for example mulberry32); same seed gives byte-identical output; the corpus SHA-256 is printed and stored with every result.
- **Schema:** the article schema (`id`, `headline`, `body`, `source`, `published_at`, `language`) with `id` as integer or string per option.
- **Size distribution:** body length log-normal, median 2.5 KB, p95 12 KB (proposed; sample-sized option for fast tests); headline 40 to 120 characters.
- **Language mix (configurable):** en 80%, ar 10%, zh 10% (proposed). Text built from per-language word lists with Zipf-like frequencies. Arabic: definite article and conjunction prefixes attached to 30% of words. Chinese: no spaces; punctuation full-width.
- **Planted mentions:** unique tokens (for example `zqplant-000123`, plus an Arabic and a Chinese equivalent) at 1% per language, recorded in a manifest so recall is computed exactly.
- **Rates:** exact duplicates (new id, same content) 2%; redeliveries (same id) 1%; late arrivals (published 1 to 48 hours earlier than neighbours) 5%; equal `published_at` ties 2%; markup (img, script, b, entities) 5%; hidden-text 0.5%; injection strings 0.5%; null-matrix items 1%; oversized 0.1%.
- **Sources:** configurable cardinality (default 50); `published_at` spread over a configurable window.
- **Output:** JSON file, NDJSON stream, or direct bulk insert helper; plus the manifest (planted ids, expected flags, expected reason codes) so assertions are computed, not hand-written.

**Fixtures** (`tests/fixtures/`): the 20 samples (copy); the injection set (override, forged delimiter, Arabic, Chinese, system-prompt request, hidden comment); the NOT-removal pair (two articles differing by one word); the tie set (equal `published_at` values); the null matrix (generated from the matrix definition); the planted multilingual set; a UTC boundary pair (`2026-07-12T23:59:59Z`, `2026-07-13T00:00:00Z`, which straddle a Monday).

**Fake providers:** record every request (to assert prompt content: fenced article, no ids or source, token cap respected, headline omitted when absent); scriptable behaviours per call or per time window; deterministic default responses derived from content hash (so golden tests are stable); jev-compatible and OpenAI-compatible response shapes.

**Test database management:** `mss_template` migrated once; each suite `CREATE DATABASE t_<n> TEMPLATE mss_template`; dropped on exit; a leak check fails the run if databases remain.

## 8. Resilience and negative tests

### 8.1 Dependency fault tables

Expected for every row: counters and logs from the telemetry spec appear; INV-1 to INV-5 hold afterwards; no key or article text in logs.

**jev (sentiment).** (Row set F-JEV-n; OpenAI rows F-OAI-n are identical except for the output validator rules.)

| ID | Fault | Expected class and retry | Final state | Degraded mode and evidence |
| --- | --- | --- | --- | --- |
| F-JEV-1 | Connection refused | Transient; backoff retries up to 4 | `succeeded` after recovery, or `dead` (`retries_exhausted`) if outage outlasts attempts and breaker did not hold | Breaker opens at threshold; jobs wait; evidence: attempts, timing distribution |
| F-JEV-2 | Timeout (no response) | Transient; per-attempt timeout honoured | as above | `provider_calls_total{outcome="timeout"}` |
| F-JEV-3 | Slow responses past threshold | Transient; latency histogram moves; concurrency cap holds | `succeeded` | No more than 4 in flight |
| F-JEV-4 | Intermittent errors (30%) | Transient; retries succeed; retry budget caps amplification | `succeeded` | Retry ratio bounded |
| F-JEV-5 | 400 | Permanent; no retry | `dead` (`client_error`) | Attempts = 1 |
| F-JEV-6 | 401/403 | Permanent; breaker opens (credential problem), worker logs a clear message | Jobs wait queued (not dead) while breaker is open | Alert condition visible |
| F-JEV-7 | 429 with `Retry-After` | Transient; delay at least `Retry-After` | `succeeded` | Delay assertion |
| F-JEV-8 | 500/503 | Transient | as F-JEV-1 | |
| F-JEV-9 | 200 with error payload, empty body, truncated JSON | Failure with reason (`invalid_output` or `bad_response`); max 2 attempts for invalid output | `dead` with raw output kept | Not treated as data |
| F-JEV-10 | Valid JSON, off-enum choice; probabilities not summing to 1 (tolerance 0.01); probability outside 0..1; confidence outside 0..1; missing `usage` | Invalid output; missing `usage` is accepted with estimated cost and flag `usage_estimated` | `dead` or `succeeded` accordingly | Never stored as 0 |
| F-JEV-11 | Duplicate delivery of a response (worker retry after success commit failure) | Idempotent | One current enrichment | INV-5 |
| F-JEV-12 | Outage longer than the retry window | Breaker opens early; attempts are not burned | All jobs `succeeded` after recovery; none `dead` | See F-BRK-4 |

| ID | OpenAI-specific | Expected |
| --- | --- | --- |
| F-OAI-1..8 | Same as F-JEV-1..8 | Same |
| F-OAI-9 | Schema violation, summary over 400 characters, summary with URL or `<`, topics count 0 or 4, topic outside vocabulary, duplicate topics, confidence outside 0..100 | Invalid output, 2 attempts, `dead` |
| F-OAI-10 | Refusal or empty content; finish reason `length` (truncated JSON) | `invalid_output` / `provider_refused` (permanent) |
| F-OAI-11 | Summary equals a fragment of the system prompt | Rejected (prompt-leak check) |

**Breaker (F-BRK).**

| ID | Scenario | Expected |
| --- | --- | --- |
| F-BRK-1 | Failures below threshold | Breaker stays closed |
| F-BRK-2 | Failures at threshold | Opens; further jobs fail fast with no call to the provider |
| F-BRK-3 | Cool-down elapses | Half-open: one probe; success closes, failure reopens; no flapping |
| F-BRK-4 | 30-minute outage with 10,000 queued jobs | No job dies; no attempts consumed while open; after recovery backlog drains faster than arrival; second provider unaffected |
| F-BRK-5 | jev open, OpenAI healthy | Summary/topics continue; article shows partial enrichment; telemetry shows per-provider state |
| F-BRK-ATT | Attempt accounting | The DBA claim statement increments `attempts` at claim time. A job claimed and then fast-failed by an open breaker must not lose an attempt: the worker must not claim for a part whose breaker is open (or must decrement on release). **Design finding (section 12); test fails until fixed** |

**Database and process faults.**

| ID | Fault | Expected |
| --- | --- | --- |
| F-DB-1 | `pg_terminate_backend` for all worker connections mid-job | Worker reconnects; job returns via sweeper; no duplicate result; INV-3, INV-4 |
| F-DB-2 | Pool exhaustion (hold all connections) while calling API | 503 with `Retry-After`, `readyz` fails, no hang; recovers when released |
| F-DB-3 | Database stopped mid-load (host-run in devops T9) | Batch fails cleanly, re-run completes, INV-1 |
| F-DB-4 | Statement timeout on search | 400/503 with "took too long" message, connection reusable |
| F-WK-1 | `kill -9` of a worker child process mid-call | Job `running` until `claim_expires_at`; sweeper returns it; reservation released; a retried paid call is allowed (bounded: at most one extra paid call per crash) |
| F-WK-2 | Worker A stalls past the visibility timeout; worker B finishes; A finishes late | A's write rejected or ignored (partial unique index and state check); budget settled once |
| F-WK-3 | SIGTERM during a call | Worker finishes or releases within the grace period; no job left `running` |
| F-CLK-1 | Day rollover with fake `Clock` | New ledger row created once (race-safe); deferred jobs resume |
| F-FLAG-1 | Kill switch off/on | Worker claims nothing while off; nothing lost; resumes on |
| F-DISK-1 (cut line) | Database on a 64 MB tmpfs filled | Ingest fails cleanly with no partial articles; recovers after space is freed |

**Budget, cost, retry arithmetic (unit and integration).**

| ID | Test |
| --- | --- |
| U-CLS-1..12 | Failure classifier: every status class and error type (ECONNREFUSED, ETIMEDOUT, 400, 401, 403, 404, 408, 409, 429, 500, 502, 503, 504, 200+error, invalid JSON) maps to transient, permanent or ambiguous; ambiguous bounded to N attempts then permanent |
| U-RETRY-1..8 | With fake clock: backoff grows exponentially, jitter within bounds, cap respected, overall deadline stops retries, `Retry-After` overrides, retry budget caps retries as a share of traffic, per-attempt timeout aborts, attempts cap |
| U-BRK-1..8 | State machine as F-BRK with fake clock |
| I-COST-1 | Token cap truncates long bodies (head 70%/tail 30%, marker, `input_truncated`); CJK and Arabic estimates stay under cap |
| I-COST-2 | Cache hit: no provider call recorded, cost 0, `origin = cache` |
| I-COST-3 | Invalid-output attempts capped at 2; transient at 4; permanent at 1 |
| I-COST-4 | Missing prices in real mode: provider refuses to start with the specified message |
| I-BUDGET-1 | 16 concurrent reservations near the cap: sum never exceeds cap |
| I-BUDGET-2 | Exhausted: jobs `deferred_budget`, `next_attempt_at` = next UTC midnight; none dropped; raising the cap resumes |
| I-BUDGET-3 | Reservation released on failure and on sweeper expiry; INV-4 |

### 8.2 Negative-input catalogue

| Group | Cases | Expected safe outcome |
| --- | --- | --- |
| SQL (I-SQL-1) | `' OR 1=1 --`, `"; DROP TABLE articles; --`, stacked statements, `%`, `_`, backslash, quotes in search box, source, language, topic filters; tampered cursor; `bucket=day`; `group_by=source`; `limit=-1`, `limit=1e9`; non-UTF-8 bytes | 400 with message or normal empty results; never a database error; schema intact |
| Static (I-SQL-2) | Search source for template-literal SQL; lint rule | Zero hits |
| Parser | See U-PARSE | Typed errors |
| Unicode | NUL, lone surrogate, bidi controls, zero-width, full-width, mixed-script homoglyphs (documented non-handled), 1 MiB body, 10,000-char headline | As the data-sanity spec |
| State | Finishing an already-succeeded job; claiming a `dead` job; replaying a replayed quarantine item; double `LoadMore` | No-op or clear error; no duplicate effects |
| Config | Invalid port, negative budget, unknown mode, key without model, prices missing | Specified messages (U-CFG) |
| Auth | No authentication in scope | Not applicable (documented) |
| XSS / prompt | See section 9 | |

### 8.3 Game days (SHOULD; blast radius is the test Compose project only)

| ID | Hypothesis (steady state) | Experiment | Abort condition |
| --- | --- | --- | --- |
| GD-1 | With a jev outage of 30 minutes during a 10,000-article load, no article is lost and enrichment completes after recovery | Fake jev returns 503 for 30 minutes | Any `dead` job, or reconciliation mismatch |
| GD-2 | An OpenAI 429 storm does not multiply load | 429 with `Retry-After` for 10 minutes | Retry ratio over the budget |
| GD-3 | DB connection loss plus worker kill together recover unattended | `pg_terminate_backend` all, then `kill -9` the worker | Any stuck `running` job after 2x visibility timeout |
| GD-4 | Budget exhausted mid-run, then raised: all deferred jobs complete | Small cap; raise after 5 minutes | Any dropped job |

## 9. Security and sanity tests

| ID | Test | Level | Expected |
| --- | --- | --- | --- |
| U-SAN-1 | Id 6 headline and body, id 18 body, exact expected reduced strings | Unit | As in data-sanity section 7 |
| U-SAN-2 | `a < b`, `5 <10`, `x<y` stay text | Unit | Unchanged |
| U-SAN-3 | Entities (`&lt;script&gt;`, `&amp;amp;`, numeric entities) decoded once | Unit | No double decoding |
| U-SAN-4 | Arabic and Chinese inside tags; presentation forms; combining marks | Unit | Text intact |
| U-SAN-5 | `<scr<script>ipt>`, `<svg onload>`, `javascript:` hrefs, `<style>` expressions, `<iframe>`, `<object>`, comments | Unit | No `<` followed by a letter in output; no attribute text |
| U-SAN-6 | Hidden text: HTML comment with instruction, `display:none`, zero-size | Unit | Dropped, flagged, counted |
| U-SAN-7 | Transformation records have counts, checksum, tool and version | Unit | |
| U-SAN-8 | 1 MiB of `<` and deeply nested tags | Unit | Linear time, bounded memory |
| U-VAL-* | Table-driven null matrix and `published_at` variants | Unit | Outcome and reason code per cell |
| U-PROMPT-1..7 | Instructions only in system message; nonce fence; nonce stripped from article; headline omitted (not "none") when absent; truncation rule; no id/source/key in request; **snapshot of the system prompt reviewed by a human** | Unit | |
| U-INJ-1..3 | Detector positives (en, ar, zh), benign negatives, timing | Unit | |
| F-INJ-1 | Injection fixtures through fake providers that obey the injected instruction (return "positive, 100%"); validator and trust marker behave | Fault | Value stored only if it passes validation; `trust = low`; flag set |
| F-INJ-2 | Hidden-text fixture | Fault | Instruction never reaches the fake provider's recorded request |
| F-INJ-3 | Forged closing delimiter | Fault | Not present verbatim in the request |
| E-XSS-1 | Component render of ids 6 and 18 and a summary containing `<img onerror=alert(1)>` | Component | No element created from article text; `renderToStaticMarkup` has no raw tags from content |
| E-XSS-2 | Playwright: open Search and Article pages for ids 6 and 18 | Browser | No dialog, `window.__xss` undefined, DOM contains text only |
| E-XSS-3 | CSP and security headers present | Integration | As specified |
| I-LOGS-1 | Full run with fake keys and all fixtures; scan captured logs | Integration | INV-10 |
| U-LOG-1 | Redaction unit test for authorization headers and key fields | Unit | |
| D-T12, D-T13 | Secret exposure, least privilege | Deployment | Per devops spec |
| I-ROLE-1 | Role grants matrix (all three roles against every table) | Integration | As DBA section 4.6 |

## 10. Test levels and when they run

| Level | Contents | Runs | Approx. duration |
| --- | --- | --- | --- |
| Unit | U-* (pure modules) | Every commit and before every commit locally | Under 20 s |
| Integration | I-*, F-* in-process with fake providers, real Postgres | Every commit (CI) and on demand | 1 to 3 min |
| Component | E-XSS-1 and similar | Every commit | Under 30 s |
| Browser | E-* with Playwright and axe | On demand and before release | 2 to 4 min |
| Deployment | D-T1 to D-T20 | Before release / on demand | 10 min |
| Measurement | M-* on 1 M rows | On demand and once before submission; M-SOAK 30 min once | 30 to 60 min |
| Real-provider smoke | R-1 (opt-in, needs keys) | Once, when keys exist | 2 min |

**Priority for the 7 to 9 hour assignment** (testing budget proposed: about 20 to 25% of build time, written alongside the code, not at the end; decision TS2):

| Tier | Contents | Estimate |
| --- | --- | --- |
| MUST | U-PARSE, U-NORM, U-SAN, U-VAL (core cells), U-VALOUT, U-PROMPT, U-INJ (basic), U-CLS, U-RETRY, U-BRK, U-CONF, U-CFG; I-MIG-1/2, I-ROLE-1, I-CONS-1/2/3, I-IDEM-1/2, I-FID-1, I-SEARCH (G1 to G12), I-NOT-1, I-SUBSTR-1/2, I-KEYSET-1 to 5, I-AGG-1 to 8, I-DRILL-1, I-COVER-1, I-CLAIM-1, I-BUDGET-1/2, I-CONF-1; E-XSS-1, E-XSS-3; F-JEV/OAI subset (1, 2, 5, 7, 9, 10); F-BRK-1 to 4; F-WK-1; M-KEYSET-1, M-TRGM-1; invariant checker | About 2 hours with AI help; about 100 cases |
| SHOULD | I-SWEEP, I-FINISH, I-QUAR, I-STATUS, I-LOGS, I-FID-2/3, I-SEARCH-12 differential oracle, E-XSS-2, E-STATES, axe, F-DB-1/2, F-WK-2/3, F-FLAG, GD-1, M-LAT-1, M-AGG-1, M-SIZE-1, M-THRU-1/2, M-CLAIM-1, M-BUDGET, M-RECOVER-1, R-1 | About 2 hours |
| COULD (cut line) | M-SOAK-1, M-MIXED-1, GD-2 to GD-4, F-DISK-1, visual bidi checks, full axe sweep | Cut first |

If time runs short, cut from the bottom and say so in the README (honest "stubbed, here is how I would finish it" scores better than a rushed suite, per the brief).

## 11. Exit criteria and reporting

Done means:

1. INV-1 to INV-10 hold after every integration scenario and after every fault scenario.
2. Every MUST test passes; every SHOULD test passes or its gap is recorded with a reason.
3. Every FP and HP in section 4 and 6 has passing coverage or a recorded gap accepted by the user (a gap in a MUST-tier FP, such as FP-6, FP-10, FP-11, FP-14, FP-15, FP-16, blocks submission).
4. Golden query results from Postgres equal the oracle's (or each difference is explained and the oracle or implementation fixed).
5. Every measurement in M-* that is in scope has a recorded result with environment details; performance claims in the README quote them with percentiles and the number of repetitions (at least 5 for latency runs, reporting median and spread).
6. Results are stored in `reports/test-<date>.md` generated by a script (environment, versions, row counts, corpus hash, tables of results, plans).

**README testing section (what to report):** how to run each level; what the tests prove (the invariants); the golden-query table with expected ids; measurement tables with environment and caveats; the explicit "not proven" list (800/s, 15-minute SLO on real feeds, multi-hour soak, real provider behaviour beyond R-1); known gaps; one or two examples where a test found a defect in the generated code (useful for the Reflection section and the transcript).

A failed MUST test blocks submission; a failed SHOULD test is a risk to record; a failed COULD test is a note.

## 12. Gaps, risks and open questions

**Design findings from planning these tests (for carma-plan's consistency report):**

| # | Finding | Where | Action |
| --- | --- | --- | --- |
| C1 | **Attempts are incremented at claim time** (DBA section 8) but the architect/telemetry design says a job waiting on an open breaker must not die. A claim followed by a fast-fail would burn an attempt | DBA claim SQL vs architect resilience table | Worker checks the breaker before claiming for that part, or releases with `attempts - 1`. Test F-BRK-ATT |
| C2 | Search spec section 3 mentions headline/body weights; DBA 4.1 removed them (recency only) | Search vs DBA | Already noted in DBA spec; keep unweighted |
| C3 | DevOps T2 expects jobs to finish within 60 s in mock mode | DevOps vs config | Add `MOCK_LATENCY_MS` (default small) |
| C4 | Drill-through equality tests need `include_total=true` | Search spec 8 | Tests pass it explicitly |
| C5 | The number of buckets cap (520) and query caps are proposed values | Search spec | Tests read the configured values |
| C6 | Time-dependent SQL uses `now()`; tests must set row timestamps instead of faking DB time | DBA | Documented in section 2; no SQL change needed |
| C7 | Retrying a paid call after a crash can bill twice | Data-sanity / architect | Accepted, bounded to one extra call per crash; cache mitigates only if the first result was stored; test F-WK-1 asserts the bound |
| C8 | Postgres `simple` tokenisation may differ from the oracle (numbers, hyphens, URLs) | Search spec FP-S11 | Differential test I-SEARCH-12; reserve time to investigate |
| C9 | Dockerfile needs a `test` target with dev dependencies | DevOps | Add to devops artefacts |
| C10 | `app_worker` needs write access to `worker.`/`breaker.` keys in `system_flags` | Telemetry vs DBA | Already applied to the DBA spec; role test I-ROLE-1 covers it |

**Risks:** 1 M-row measurements on Docker Desktop are relative only; the oracle shares assumptions with the implementation (mitigated by the differential test and the independently computed golden ids); fake providers cannot reproduce real provider behaviour (mitigated by R-1); the time budget for tests is tight against the build.

**Open questions:** the OpenAI model id, prices for both providers and whether keys will be available for R-1; whether the user wants a `reports/` directory committed (assumed yes); whether Playwright browsers may be downloaded in the `test` image (adds image size).

## 13. Handoff to carma-plan

Order of work: (1) test seams in the code skeleton (Clock, pure modules, worker in-process); (2) `tools/gen`, fixtures, fake providers, template-DB harness and `assertInvariants`; (3) unit suites alongside each module; (4) integration suites as each stage lands (ingest, search, list/aggregate, worker, budget); (5) fault and negative suites after the worker exists; (6) measurement runs on 1 M rows once the schema is final; (7) report generation and the README testing section; (8) opt-in R-1 when keys exist. Add the `test` Dockerfile target and the `test`/`fakes` profile services to the devops tasks.

## 14. Decisions needed

| ID | Decision | Options (recommended first) |
| --- | --- | --- |
| TS1 | Test tooling | (a) Vitest + React Testing Library + Playwright; (b) Node's built-in `node:test` (no dependency) plus Playwright; (c) Jest |
| TS2 | Testing time budget and cut line | (a) About 20 to 25% of build time with the MUST/SHOULD/COULD tiers in section 10; (b) smaller (MUST only); (c) larger (include soak and game days) |
| TS3 | Test data policy | (a) Synthetic and the provided samples only; (b) also anonymised real samples (none provided) |
| TS4 | Fault injection scope | (a) Only inside the test Compose project, with fake providers and `pg_terminate_backend`; (b) also stopping containers via the Docker socket (more realistic, needs socket access) |
