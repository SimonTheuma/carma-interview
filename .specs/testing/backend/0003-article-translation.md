---
spec: carma-backend-testing
number: 0003
title: Test plan for article translation
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0017-test-tooling-and-tiers.md, .specs/architect/adrs/0022-translate-at-ingest-as-enrichment-part.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/search/0002-article-translation.md, .specs/data/sanitization/0003-article-translation.md, .specs/data/dba/0003-article-translation.md, .specs/telemetry/0003-article-translation.md, .specs/ux/0003-article-translation.md, .specs/devops/0003-article-translation.md, .specs/testing/backend/0002-json-file-upload.md]
principles: [P2, P3, P5, P6, P7, P8]
supersedes: null
---

# 0003 Test plan for article translation

## 1. Summary and scope
The bug that matters here is a foreign article that silently has no usable English text and no recorded reason, or one whose "translation" is wrong text shown as right. The plan proves: every foreign article is accounted for; translations are version-bound and never overwrite the original; invalid model output is never shown; search works on both sides; the page is honest in every state; and the enqueue does not slow ingestion. It extends the existing suites and tiers (ADR-0017) and does not repeat deployment tests (devops 0003 section 9) or the upload tests (testing 0002).

## 2. Test environment and tooling
Current state (paths):
- Vitest for `tests/unit/**` and `tests/integration/**` (`vitest.config.ts`); Playwright for `tests/e2e/**` (`playwright.config.ts`, `smoke.spec.ts`, `upload.spec.ts`).
- Integration tests use a real PostgreSQL through `tests/harness/db.ts` (`createTestDb`, disposable database per suite, skipped when Postgres is unreachable) and the migration runner.
- Provider seam: `tests/fakes/providers.ts` (`createRecordingProviders`) records calls and returns fixed results. The worker takes `EnrichmentProviders`, so a translator fake plugs in at the same place.
- Fixtures: `tests/fixtures/articles.ts`. Benchmarks: `.benchmarks/article-ingest/` (`bench.mjs`, `bench-lib.mjs`) with seeded generation and a conservation check.
- No CI configuration was found in the repository (devops 0003 section 10).
Additions
1. `tests/fakes/translator.ts`: a scriptable translator implementing the new `translate()` method. Modes: `ok` (deterministic English from a lexicon), `echo`, `empty`, `wrong_lang`, `short` / `long` (ratio), `drop_paragraph`, `extra_paragraph`, `injected_output`, `markup` (returns `<script>` / markdown), `error(status)`, `timeout`, `slow(ms)`, `fail_on_chunk(n)`. It records calls per chunk so cache reuse can be asserted.
2. Fixtures: foreign articles in `ar`, `zh`, `fr`, `en`, `unknown`, mixed Arabic/Latin, long (1, 20, 21 chunks), injected body, no headline, no body (`tests/fixtures/translation.ts`).
3. A fake clock already exists (`src/lib/clock.ts`); use it for backoff, lag and budget-day tests.
4. Benchmark extension: `.benchmarks/article-ingest` gains a `--foreign-share` flag (carma-benchmark territory; this plan states the thresholds).
5. Playwright with the mock translator for UI tests, running on the Compose stack with no key (devops 0003 mock mode).

## 3. Integrity invariants and tests
| ID | Invariant | Test | Level |
| --- | --- | --- | --- |
| I1 Conservation | For all foreign articles in a set: `count = translated + queued + running + failed_retryable + deferred_budget + dead + skipped_no_content`, per article version; English articles have no translation job | Ingest the fixture set with the mock translator, run the worker to quiescence, run the ledger query used by telemetry T4; also assert at intermediate points (before worker, after half) | Integration |
| I2 Original untouched | `articles.headline/body/search_text/content_hash/version` unchanged by any translation outcome | Snapshot before and after worker runs, all fake modes | Integration |
| I3 Version binding | A current translation always has `article_version = articles.version` | New version arrives (a) before the job is claimed, (b) while it runs, (c) after it succeeded; assert one current row, correct version, old row superseded, stale job `superseded_version`, no write by the late worker | Integration (concurrent) |
| I4 Idempotency | Same article ingested twice or translation job run twice leaves one current translation and one enrichments row | Duplicate ingest; run worker, reset job to queued, run again; crash after insert before job success | Integration |
| I5 Chunk integrity | Joined translation has the same paragraph count as the source; digit sequences preserved; no chunk dropped or duplicated | Property test over random paragraph structures (seeded) with fixed splitter; assertions on count and order; the fake returns `[n]`-tagged paragraphs so order errors are visible | Unit + integration |
| I6 Cache reuse | After a failure at chunk k, retry calls the translator only for chunks k..n; final text equals the uninterrupted run | `fail_on_chunk(7)` of 10, assert call log; compare final text hash with a clean run; cache rows deleted after success | Integration |
| I7 Fidelity | Stored `headline_en/body_en` equal the accepted output byte for byte after documented sanitising only (NUL removal, bidi override removal, U+FFFD) | Inputs with NUL, bidi overrides, lone surrogates in output | Unit |
| I8 No partial display | A job with any rejected chunk writes no translation row | `fail`/`echo` on chunk 3; assert zero rows | Integration |
| I9 No confidence | No `derived_values` row is written for translation; the page shows "no confidence" text | Query + UI test | Integration, e2e |
| I10 Lineage | The translation row links to an `enrichments` row with provider, model, prompt version, input hash, trust, cost; mock rows have origin `mock` | Assertions per mode | Integration |
| I11 Multilingual round trip | ar, zh, fr, mixed ar/Latin, en, unknown: enqueue decision, language checks, ratio checks and storage correct for each; English is skipped; unknown is queued | Table-driven fixtures through enqueue and worker | Unit + integration |
| I12 Search completeness | See section 8.3 | | Integration |

## 4. Failure-point coverage matrix
| FP | Test | Technique | Expected |
| --- | --- | --- | --- |
| FP-1 No job enqueued (architect) / FP-DB1 old overload | Enqueue unit tests per language; new version path with and without `p_needs_translation`; call the old function signature and assert it does not exist | Table, SQL introspection | Every foreign version has a job; reconciliation T4 query returns 0 rows |
| FP-2 Job dead/deferred | Fake `error(400)`, budget exhausted; page state tests | Fault injection | Original shown with the specified message, counted in `mss_translation_coverage` |
| FP-3 / FP-D6 Chunk join, grapheme splits | I5 plus fixtures with surrogate pairs, combining marks, Arabic ligatures, CJK without spaces, one 50,000-character paragraph | Property + examples | No split inside a grapheme; counts equal |
| FP-4 Echo or wrong language | Fake `echo`, `wrong_lang`, English-labelled-as-fr, Arabic-labelled-as-en | Output validators | Rejected with reason `out_echo` / `out_wrong_lang`; job retries then dead |
| FP-5 / FP-D1 Prompt injection | Injection strings (en/ar/zh) in body; model "obeys" (fake returns the injected instruction); nonce-fence breakout attempt | Input + output tests | Translation still produced when output is clean, `trust='low'`, banner shown; obeyed output rejected `out_injected` |
| FP-6 / FP-DB2 Version race | I3 under concurrency (50 parallel completions and 50 parallel new versions of the same articles, repeated 20 times) | Concurrency | Never two current rows, never a current row of an old version |
| FP-7 Bidi rendering | Playwright with RTL original, LTR translation (section 9) | e2e | Correct `lang`/`dir`, screenshot compare |
| FP-8 / FP-V5 Budget starvation | Exhaust translate cap only; run sentiment/summary jobs | Budget test | Translation `deferred_budget`; other parts continue; next UTC day resumes (fake clock) |
| FP-9 Language mislabel | Fixture set; the audit is a manual sample and listed as a gap | | |
| FP-10 / FP-S1 Search ignores translations | Section 8.3 per operator | | |
| FP-S2 Superseded translation matches | Search after a new version; also after manual `superseded_at` | | No match from superseded text |
| FP-S3 Normalisation mismatch | Same normaliser used at index and query; test with accents, NFKC forms, case, full-width | Unit + integration | A term with different Unicode forms matches |
| FP-S4 / FP-DB4 / HP-S1 Plan regression | Section 6 | | |
| FP-D2 / FP-D3 Thresholds too tight/loose | Calibration set: 30 real-looking pairs per script (good, truncated, hallucinated, echoed) labelled by hand; report acceptance rate per class | Evaluation | Good accepted ≥ 95%, bad rejected ≥ 90% (proposed) |
| FP-D4 Retry storm | Fake `error(503)` for all chunks; count calls | Retry test | Calls bounded by attempts × chunks; cache prevents re-translation of passed chunks |
| FP-D5 HTML sink | Static test: grep components for `dangerouslySetInnerHTML`/`innerHTML` in translation components; render `<script>` text and markdown | Static + e2e | Literal text, no execution, no links |
| FP-DB3 Constraint lock | Devops 0003 test; here: unit test that migration uses `NOT VALID` then `VALIDATE` | Migration test | |
| FP-DB5 Cache not purged | Sweeper test with fake clock | Integration | Rows older than `TRANSLATE_CACHE_DAYS` removed; newer kept |
| FP-DB6 Trigram later | Not built; a lint-level check that the migration has no non-concurrent index creation on populated tables | Review checklist | |
| FP-V1 Scale infeasibility | No test; documented gap and decision (section 11) | | |
| FP-V2 Mock mistaken for real | UI and API tests: origin `mock` shows "Mock translation" label; `/api/status` provider mode | e2e | |
| FP-V3 Held DB connection | Run 3 long fake translations (`slow(5s)`), sample `pg_stat_activity` | Integration | No connection idle in transaction beyond claim; pool never exhausted |
| FP-V4 Rollback signature | Devops test | | |
| FP-V6 Real mode without key | Config unit test | | Process exits with named variable |
| Telemetry signals | Each failure test above also asserts the counter/log named in telemetry 0003 section 12 | | |

## 5. Soft requirements
| Claim | Threshold | Method | Load | Evidence |
| --- | --- | --- | --- | --- |
| Ingest is not slowed by the enqueue (HP-1/HP-DB1) | rows/s with 30% foreign within 5% of 0% foreign (proposed) | `.benchmarks` comparison, 100,000 articles, multi-row job insert vs per-job loop | seeded generator, language mix en 50 / ar 20 / zh 15 / fr 15 | JSON report with environment |
| Freshness of the original is unchanged | share searchable within 15 min unchanged (agreed target) | run the existing freshness check with the translation lane busy and slow | PoC rate | existing report format |
| Translation lag (T-SLI-1) | 95% within 30 min, 99% within 6 h (proposed) | mock translator with 200 ms latency, 15,000 foreign articles/day equivalent compressed | PoC, 2-worker lane | histogram from `mss_translation_lag_seconds` |
| Search latency with translations (T-SLI-5) | p95 under 1 s and within +25% of baseline (proposed) | Plan experiment HP-S1 (section 6), then API-level run | 200k articles, 30% foreign, all translated | p50/p95/p99 and EXPLAIN |
| Page load with translation | p95 under 300 ms server time (proposed) | 200 sequential and 20 concurrent page loads | seeded | route histogram |
| Lane throughput | at least 5 articles/s with mock latency 100 ms and concurrency 8 (proposed) to show the lane is not the bottleneck; real throughput is provider-bound (devops 0003 section 3) | lane test | | |
| Spend bound | spend never exceeds `BUDGET_TRANSLATE_DAILY` plus one article's reservation | budget fake with token usage | 1,000 articles | ledger |
| Storage per translation | measured vs DBA 0003 section 3 (about 5 KB) | first experiment from DBA 0003 | 10,000 | table/index sizes |
No soak or 800/s run is planned for the translation lane because the lane cannot reach that rate (devops 0003 section 3); a 6-hour PoC-rate soak (COULD tier) checks bloat on `article_translations`, GIN pending list and cache cleanup.

## 6. Hot path measurements
| HP | Measurement | Trigger for human inspection |
| --- | --- | --- |
| HP-1 / HP-DB1 enqueue | Benchmark above; also statements per article from `pg_stat_statements` | More than one extra statement per article, or rows/s drop over 5% |
| HP-2 translation lane tokens | Tokens and cost per article by script from the fake usage; real-model sample of 200 articles | Cost per article more than 2x the estimate |
| HP-3 article page query | `EXPLAIN (ANALYZE, BUFFERS)` of the translation lookup | Not using `article_translations_current_uq` |
| HP-S1 / HP-DB2 search plan | Compare OR+EXISTS, UNION, and two-bitmap forms for: rare term, common term, phrase, NOT, wildcard; keyset ordering, LIMIT 20; with and without ANALYZE | p99 over 1 s or a sequential scan on either relation |
| HP-D1 / HP-V1 validators | Microbenchmark: ms per 100 KB for Arabic, CJK, Latin; test regexes for backtracking with pathological strings | Over 50 ms per 100 KB, or any super-linear growth |
| HP-DB3 save transaction | Latency percentile of the save under 50 concurrent completions | p99 over 200 ms |

## 7. Load generator and test data
- Extend the existing seeded generator: `--foreign-share`, language mix, body size distribution (1 to 20 KB, long tail), planted terms in the original and in the mock translation (the lexicon maps planted original terms to planted English terms so searches have known answers), duplicate and new-version rate, injected-body rate (1%).
- Mock translator: deterministic, offline, latency parameter; produces paragraph-tagged output so order checks are possible. The same generator seeds both the `.benchmarks` harness and the Playwright stack.
- Synthetic data only (the sample file is allowed); no real articles.
- Record environment (CPU, RAM, disk type, Postgres 16.6 settings, data volume) with every result.

## 8. Resilience and negative tests

### 8.1 Dependency faults (OpenAI translate)
| Fault | Retry | Breaker | Dead letter | Degraded mode | Evidence |
| --- | --- | --- | --- | --- | --- |
| Timeout on one chunk | Transient: backoff with jitter, attempts ≤ `MAX_ATTEMPTS`; cache keeps earlier chunks | Counts toward the `openai-translate` breaker only | After attempts: dead `attempts` | Original shown, "Translation unavailable" | call log, timing distribution, counters |
| 429 with Retry-After | Retry honours the wait (fake clock) | Not tripped by a single 429; trips on sustained rate | n/a | Pending state | |
| 5xx burst (30% for 5 min) | Retries; retry budget caps amplification | Opens at the threshold, half-opens after cool-down, one probe | none if recovered | Jobs queued durably, page "in progress" | breaker gauge, no flapping |
| 400/401/403 | No retry (permanent) | Opens only for 401/403 as an auth failure (per classifier) | dead `permanent` immediately | Original + reason | |
| Malformed or truncated JSON | `invalid_output`, ≤ 2 attempts | Not tripped | dead `invalid_output` | | |
| Valid but wrong (echo, wrong language, empty, wrong paragraph count) | as `invalid_output` | not tripped | dead with the check's reason | | validator counters |
| Outage longer than retry window | Jobs `failed_retryable` until attempts end, then dead and replayable | Open | Replay after recovery is rate-limited (`RPM_TRANSLATE`) | | replay test: reset jobs, drain without exceeding limit |
| Breaker open with summaries still working | n/a | Separate breaker names | | Summary/sentiment keep flowing | cross-lane test |
| Provider down while DB fails over | combination | | | Claims expire, jobs resume | game day |
Isolation: translation outage must not delay sentiment or summaries (bulkhead): run both lanes, fail translation, assert enrichment time unchanged (±10%).

### 8.2 Negative inputs
Null, empty, whitespace headline/body; `"null"` string; language NULL/empty/`"N/A"`/very long/invalid tag; body at 1 char, at the cap, over `TRANSLATE_MAX_CHUNKS` (20 and 21 chunks exactly); NUL, lone surrogates, zero-width and bidi controls in source and in model output; model output with Markdown, HTML, links, 10x the input length; duplicate delivery; job for a deleted or superseded article; claim by a worker whose claim expired; job with a prompt version no longer configured. Expected: a recorded reason code, no partial writes, no crash, no text in logs.

### 8.3 Search tests (both sides, ADR-0025)
Seeded corpus with planted terms: only in original (`O`), only in translation (`T`), both (`B`), neither, and a superseded translation term (`S`).
| Case | Expected |
| --- | --- |
| Plain term `O`, `T`, `B` | found; `matched_in` original / translation / both |
| Phrase `"T T"` | found via translation vector |
| Wildcard prefix on `T` | found |
| `NOT T` | does not exclude the article (NOT is original-side only, ADR-0027); `NOT O` excludes it |
| `A AND T`, `A OR T` | correct boolean |
| Arabic/Chinese term (substring leaf) | matched on the original, and on a translation that keeps the name in its own script (planted case, via the trigram index) |
| Term `S` after new version | not found; new text found only once translation completes |
| Article with translation pending | found by original terms; the not-translated note counts it |
| Mock translation | found with the mock marker |
| English article | unchanged behaviour (regression run of the whole existing search suite) |
| Normalisation | `Café`, `CAFE`, full-width Latin, NFC vs NFD |
| Result ordering and keyset pagination | stable across pages when a translation match is added |
| Injection in query text | parameterised, no SQL change (existing tests extended) |
Existing search tests run unchanged as a regression; any change in their results is a failure.

### 8.4 Game days (COULD tier, on demand)
1. Kill the worker repeatedly during a long article (15 chunks): exactly one current translation, spend equals one full translation plus cached reuse.
2. Block egress for 10 min at 30% foreign share: breaker opens, backlog builds, drains after unblocking within one hour, no second outage (rate-limited), reconciliation balances.
3. Flip `translation_enabled` off/on under load: no claims while off; no job lost.
Steady-state hypothesis and abort conditions are written before each run (disk and connection thresholds).

## 9. Security, UI and sanity tests
| Test | Level | Expected |
| --- | --- | --- |
| XSS: translation containing `<script>`, `<img onerror>`, `javascript:` URLs, Markdown links | e2e + component | Rendered as literal text; no element created (assert DOM has no such nodes) |
| Bidi: Arabic original in a LTR page; translation LTR; original block `dir=auto` | e2e | `lang` and `dir` attributes per block, screenshot compare of both views |
| Toggle semantics | e2e | Default shows translation; button has `aria-pressed` false → true on click; accessible name correct; Enter and Space work; focus stays; live region text updates; click again returns |
| No layout jump | e2e | Bounding box of the translation bar and first line position unchanged before/after toggle (tolerance 2 px); scroll position unchanged |
| Both texts in HTML | e2e (JS disabled run too) | Both text blocks exist in server HTML; inactive one hidden; with JS disabled the translation is visible and the original is reachable (a `<details>`/anchor fallback if specified in implementation, otherwise documented as a gap) |
| States | e2e / component | Pending, paused, failed (3 reasons), no content, low trust, English, unknown language, load error: exact copy from UX spec section 9; original shown in each |
| Mock label | e2e | "Mock translation ..." text and About panel |
| Search card | e2e | Tag and English headline line appear only for translation matches; untranslated note count matches DB |
| Beacon | integration | `POST /api/telemetry/translation-view` accepts only the enum, ignores extra fields, 204, rate-limited, writes no DB rows |
| Secrets/logs | unit | Redaction test extended: translation text, key, headline never in log output (`tests/unit/log-redact.test.ts` pattern) |
| Mobile 360 px | e2e | No horizontal scroll with long Arabic/CJK lines; button reachable and ≥ 44 px |
| Accessibility | e2e (axe) | No serious violations on the translated and original views |

## 10. Test levels and when they run
| Tier (ADR-0017) | Tests | When |
| --- | --- | --- |
| MUST, every commit | Unit: enqueue rule, chunker, validators, config, metrics label allow-list; integration: I1 to I11, search 8.3, version race (reduced repetitions), cache reuse, budget, kill switch; static HTML-sink check | per commit / before merge |
| SHOULD, nightly or before release | Playwright UI suite (section 9), calibration set (FP-D2/D3), HP-1 benchmark, HP-S1 plan comparison, concurrency repetitions ×20, provider-fault table 8.1 | nightly / on demand |
| COULD | 6-hour PoC-rate soak, game days 8.4, real-model 200-article sample | on demand |
The integration tests skip without Postgres (existing behaviour); the release gate requires them to have run.

## 11. Exit criteria and reporting
Done when: I1 to I12 pass; every FP above has a passing test or an accepted gap; faults in 8.1 behave as designed with recovery needing no manual step; HP-1 within threshold; search plan chosen and recorded; UI suite green including a11y; calibration thresholds met or the thresholds adjusted by a named person. Reports are JSON plus a short Markdown summary under `reports/` (the directory already exists), with environment details; repeated runs report min/median/max. A failed invariant (I1 to I4, I8) is a blocker; a missed proposed threshold is a risk accepted by the user.

## 12. Gaps, risks and open questions
- FP-9 (language mislabel) and FP-V1 (scale) have no automated test; manual sampling and a user decision respectively.
- Translation quality is not tested; only the guards around it (ADR-0024). A human-reviewed sample (P9) is out of scope.
- Real-model behaviour (refusals, formatting) is covered only by a 200-article sample and the calibration set; thresholds are proposed.
- JS-disabled behaviour of the toggle depends on the implementation choice (UX spec); decide when building.
- Proposed thresholds (5%, +25%, 95/99%, 50 ms per 100 KB) are UNCONFIRMED.
- No CI found; the MUST tier needs a runner to be meaningful.

## 13. Handoff
carma-plan schedules: (1) translator fake and fixtures; (2) migration and enqueue tests with the schema; (3) worker and validator tests alongside the implementation; (4) search tests with the compiler change; (5) UI tests with the component; (6) benchmark and plan experiment; (7) calibration set; (8) optional soak and game days.
