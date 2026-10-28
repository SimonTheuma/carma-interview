---
spec: carma-telemetry
number: 0003
title: Telemetry for article translation
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0014-observability-stack.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/search/0002-article-translation.md, .specs/data/sanitization/0003-article-translation.md, .specs/data/dba/0003-article-translation.md, .specs/telemetry/0002-json-file-upload.md]
principles: [P1, P2, P3, P6, P7]
supersedes: null
---

# 0003 Telemetry for article translation

## 1. Summary
Translation is an enrichment. It is not held to the 15-minute mention target (that clock covers searchability of the original text), but it gets its own lag SLO because a foreign article is invisible to English searches until it is translated (ADR-0025, P3). The plan extends the existing in-process registry and Prometheus setup: new jobs reuse the `part` label with value `translation`, a few new metrics cover validation rejections, chunking, search and the reveal button. No new tool.

## 2. Current observability
- Metrics: in-process registry with a fixed label allow-list (`src/lib/metrics.ts`: `provider, part, outcome, state, method, code, origin, reason, route, status_class, pool, query, kind, phase, batch_kind`). Adding a label key requires editing `ALLOWED_LABEL_KEYS` and the catalogue test (`tests/unit/metrics-labels.test.ts`). Prometheus scrape and alert rules in `ops/prometheus.yml`, `ops/alerts.yml`, Grafana provisioning in `ops/grafana/`.
- Existing series reused: `mss_jobs{part,state}`, `mss_job_outcomes_total`, `mss_job_oldest_age_seconds`, `mss_time_to_enriched_seconds`, `mss_budget_deferred_total`, `mss_prompt_injection_suspected_total`, `mss_db_query_duration_seconds{query}`, `mss_http_request_duration_seconds{route}`, breaker flags `breaker.*` written through `worker_set_flag`.
- Logs: structured JSON with redaction (`src/lib/log.ts`, `tests/unit/log-redact.test.ts`).
- Gaps: no browser-side telemetry exists (UI spec 0002 listed it out of scope); breaker state has no per-name gauge for a third breaker; no series tells how far a language group is behind in translation.

## 3. SLIs and SLOs
All targets are proposed (none given by Carma); tune after the first week of real data.
| SLI | Definition | Source | Proposed target | Alert | Owner |
| --- | --- | --- | --- | --- | --- |
| T-SLI-1 Translation lag | `translation job succeeded_at - articles.ingested_at`, per job, excluding time in `deferred_budget` | `mss_translation_lag_seconds` histogram | 95% within 30 min, 99% within 6 h, over 7 days | T1 | Backend |
| T-SLI-2 Translation coverage | foreign articles with a current translation divided by foreign articles older than the lag target, in `done`/`pending`/`failed`/`deferred` split | ledger gauge `mss_translation_coverage_ratio` | 98% (excluding deferred and `too_long`) | T2 | Backend |
| T-SLI-3 Output acceptance | accepted translation chunks / chunks returned by the provider | `mss_translation_chunks_total{outcome}` | 95% accepted over 1 day, per script | T3 | Backend |
| T-SLI-4 Reconciliation | foreign articles = translated + queued + running + deferred + dead + skipped, per hour | `mss_translation_reconcile_mismatch_total` | 0 mismatches | T4 | Backend |
| T-SLI-5 Search impact | p95 search duration with the translation OR/EXISTS, compared with the pre-feature baseline | `mss_search_duration_seconds` split by `kind` | p95 within +25% of baseline, under 1 s | T5 | Backend |
| T-SLI-6 Spend share | tokens/cost of the translation part against its budget share | `mss_llm_cost_micro_total{part}` (existing) | stays under the configured share per UTC day | existing budget alert (A5) | Backend |
The 15-minute freshness SLO is unchanged and must not regress: translation work shares the `openai` bulkhead only through budget, not through the ingest path.

## 4. Metric catalogue (new)
Labels use the existing allow-list; two keys are added: `script` (latin, arabic, cjk, other; 4 values) and `view` (translated, original; 2 values).
| Name | Type | Unit | Labels (cardinality) | Where | Serves |
| --- | --- | --- | --- | --- | --- |
| `mss_translation_lag_seconds` | histogram | s | none; buckets 60, 300, 900, 1800, 3600, 21600, 86400 | worker on success | T-SLI-1 |
| `mss_translation_chunks_total` | counter | chunks | `outcome` (accepted, rejected, cache_hit), `reason` (empty, echo, wrong_lang, length, mismatch, injected, bad_text; 7), `script` (4) | worker validators | T-SLI-3; FP-4, FP-D2, FP-D3 |
| `mss_translation_chunks_per_article` | histogram | chunks | none; buckets 1, 2, 3, 5, 10, 20 | worker | HP-2, FP-D4 |
| `mss_translation_input_tokens_total`, `mss_translation_output_tokens_total` | counter | tokens | `origin` (provider, mock, cache) | worker | HP-2, T-SLI-6 |
| `mss_translation_dead_total` | counter | jobs | `reason` (too_long, invalid_output, permanent, attempts, budget_never; 5) | worker finish | FP-2, FP-D1 |
| `mss_translation_enqueue_total` | counter | articles | `outcome` (queued, not_needed, no_content, lang_unknown) | ingest | FP-1, HP-1 |
| `mss_translation_coverage` | gauge | articles | `state` (translated, queued, running, deferred, dead, skipped) | status refresher (ledger query) | T-SLI-2, T-SLI-4 |
| `mss_translation_reconcile_mismatch_total` | counter | checks | none | hourly ledger check | FP-1, T-SLI-4 |
| `mss_translation_stale_current` | gauge | rows | none | ledger query: current translation where `article_version <> articles.version` | FP-6, FP-DB2 |
| `mss_translation_cache_rows`, `mss_translation_cache_oldest_age_seconds` | gauge | rows, s | none | sweeper | FP-DB5 |
| `mss_search_matches_total` | counter | results | `kind` (original, translation, both) | search route | ADR-0025, FP-S1 |
| `mss_search_foreign_untranslated` | gauge | articles | none (last computed value, refreshed every 60 s over all time, not per query) | status refresher | search coverage line |
| `mss_translation_view_total` | counter | events | `view` (translated, original) | beacon route (below) | usage of the reveal button |
| `mss_translation_page_state_total` | counter | pages | `state` (translated, pending, failed, deferred, not_needed) | article page server render | P3, UX honesty |
Existing series get new label values only: `mss_jobs{part="translation"}`, `mss_job_outcomes_total{part="translation"}`, `mss_job_oldest_age_seconds{part="translation"}`, `mss_db_query_duration_seconds{query="translation_save"}` and `{query="search_translation_exists"}`, `mss_breaker_state{provider="openai-translate"}` (the translate breaker name from architect 0003 section 8; extend `worker_set_flag` key `breaker.openai-translate`, already allowed by the `breaker.%` rule).

## 5. Logs
Structured events, level `info` unless noted; all carry `article_id`, `article_version`, `job_id`, `part="translation"`, `language` (as stored), `build`, `prompt_version`. Never the text, headline, chunk content, or the model output (extends redaction test).
| Event | Level | Extra fields |
| --- | --- | --- |
| `translation.enqueued` | debug | `outcome` (sampled 1%) |
| `translation.chunk_rejected` | warn | `chunk_idx`, `reason`, `len_in`, `len_out`, `ratio`, `script`, `detected_lang` |
| `translation.accepted` | info | `chunk_count`, `input_tokens`, `output_tokens`, `cost_micro`, `trust`, `flags[]`, `cache_hits`, `duration_ms` |
| `translation.dead` | warn | `reason`, `attempts`, `last_error` (existing safe formatter) |
| `translation.superseded` | info | `job_version`, `article_version` (late result discarded) |
| `translation.injection_flag` | warn | `chunk_idx`, `trust="low"` (also increments the existing counter) |
Decision records (P7): `translation.accepted` is the record that links an article to the model, prompt version and flags; the same data sits in `enrichments`, so a developer can answer "why does this article show this translation" from one log line plus the `/api/articles/:id/trace` JSON, which gains the translation row (UX/plan item).

## 6. Traces
Span `translation.job` (parent) with children `translation.chunk` (attrs: `idx`, `tokens_in`, `tokens_out`, `cache_hit`, `outcome`) and `translation.save` (DB). Search spans gain attribute `search.translation_side=true` when the EXISTS branch is present. Sampling: head 1% baseline (existing), keep 100% of jobs that end `dead`, `rejected`, or exceed 5 minutes (tail rule, if the stack supports it; otherwise log only, UNCONFIRMED).

## 7. Request and response times
| Interface | Metric | Buckets | Notes |
| --- | --- | --- | --- |
| OpenAI translate call (per chunk) | `mss_provider_duration_seconds{provider="openai-translate"}` (existing histogram, new value) | 0.5 to 60 s | timeout per chunk from config; per-job deadline logged |
| Article page | `mss_http_request_duration_seconds{route="article"}` | existing | one extra indexed lookup; watch for regression |
| Search | `mss_search_duration_seconds` with `kind` unchanged, plus plan experiment baseline | existing | T-SLI-5 |
| `POST /api/telemetry/translation-view` | `mss_http_request_duration_seconds{route="ui_event"}` | existing | fire-and-forget |

## 8. Reveal-button usage event
Browser telemetry does not exist, so add the smallest thing that works: the client component posts `{view: "translated"|"original"}` with `navigator.sendBeacon` to `POST /api/telemetry/translation-view`. The route validates the enum, ignores everything else, increments `mss_translation_view_total{view}`, returns 204, writes nothing to the database, and is rate-limited per process (e.g. 20/s, over that it drops and counts `mss_ui_event_dropped_total`). No article id, user id or text is sent, so there is nothing personal to retain. Cost: one tiny route; benefit: tells whether readers trust or distrust translations (share of page views that click "show original"). Optional: can be dropped without affecting the feature. UNCONFIRMED whether the user wants it.

## 9. Alerts and runbook pointers
| ID | Condition | Severity | First check |
| --- | --- | --- | --- |
| T1 | share of jobs within 30 min below 95% over 6 h, or `mss_job_oldest_age_seconds{part="translation",state="queued"}` above 1 h | Ticket | breaker `openai-translate`, budget deferrals (`mss_budget_deferred_total`), worker concurrency |
| T2 | `mss_translation_coverage{state="dead"}` rising for 3 h, or coverage ratio below 98% | Ticket | `mss_translation_dead_total` by reason; `too_long` means raise the chunk cap or accept |
| T3 | rejected chunk share above 5% over 1 h, any `script` | Warn | `mss_translation_chunks_total` by reason and script; recent prompt or model change; sample a few chunks from logs (lengths only) |
| T4 | `increase(mss_translation_reconcile_mismatch_total[1h]) > 0` | Page | ledger query: foreign articles with no translation job; check the `isEnglish` rule and `ingest_new_version` parameter (FP-DB1) |
| T5 | search p95 above 1 s or 25% above baseline for 30 min | Warn | `kind` split, plan for `search_translation_exists`, GIN pending list size |
| T6 | `mss_translation_stale_current > 0` for 10 min | Ticket | version check in the save path; advisory lock (DBA section 8) |
| T7 | `mss_translation_cache_oldest_age_seconds` above 10 days | Ticket | sweeper |
| T8 | injection flag rate on translation inputs above 5× the 7-day baseline | Warn | source breakdown in logs; possible attack on a source |
Breaker open for `openai-translate` is covered by the existing breaker-open alert once the name is added to `ops/alerts.yml`.

## 10. Dashboards
Infra view (new row "Translation"): lag p50/p95/p99 (T-SLI-1), coverage by state (stacked), queue age, spend share against the cap, breaker state, search p95 with `kind` split.
Developer view (new row): rejection reasons by script, chunks per article, tokens per article, last 20 `translation.dead` and `translation.chunk_rejected` log lines (lengths and reasons only), lookup by article id showing page state, translation row, job trail. Product row: `translated` versus `original` view clicks, page state mix (how often readers see "pending").

## 11. Overhead and cardinality budget
- All new labels are bounded (largest series: chunks `outcome × reason × script` = 3 × 7 × 4, in practice far fewer). No `source`, `language` (raw), `article_id` or text as labels; `language` and `source` live in logs and span attributes.
- Volume: translation events are per foreign article, not per ingested article. At 800/s with 10% foreign: 80 jobs/s, about 4 chunks each, so about 320 `translation.chunk_*` counter increments/s (in-process, negligible); logs only on rejection, dead, accepted: about 80 lines/s at 10% foreign, roughly 300 bytes each, about 2 GB/day. At PoC volume (50,000/day) it is a few MB. Sample `translation.accepted` to 10% above 20 jobs/s (config) to keep the 800/s case near 0.2 GB/day. UNCONFIRMED against the actual log retention.
- Ledger gauges (`coverage`, `stale_current`, `foreign_untranslated`) run one grouped query each every 60 s on the read pool, using the partial indexes (DBA 0003 section 7). Verify each stays under 200 ms at 1M rows.

## 12. Coverage of the architect registers
| ID | Signal |
| --- | --- |
| FP-1 | `mss_translation_enqueue_total`, T4 reconciliation |
| FP-2 | `mss_translation_coverage{state}`, `mss_translation_dead_total`, `mss_translation_page_state_total` |
| FP-3 | `mss_translation_chunks_total{reason="mismatch"}` |
| FP-4 | `reason="echo"`, `reason="wrong_lang"` |
| FP-5, FP-D1 | `mss_prompt_injection_suspected_total`, `reason="injected"`, T8 |
| FP-6, FP-DB2, FP-S2 | `mss_translation_stale_current`, T6 |
| FP-7 | no metric (rendering); covered by Playwright test in the testing spec |
| FP-8 | `mss_budget_deferred_total`, spend share T-SLI-6 |
| FP-9 | `lang_unknown` outcome in `mss_translation_enqueue_total`; language-mix sampling is a manual audit |
| FP-10, FP-S1, FP-S3 | `mss_search_matches_total{kind}` (a zero `translation` share while translations exist), tests |
| FP-D2, FP-D3 | chunk rejection share by script (T3) |
| FP-D4 | `mss_translation_chunks_total{outcome="cache_hit"}`, chunks per article, tokens |
| FP-DB3 | migration lock time (measured in test, not production metric) |
| FP-DB4, FP-S4, HP-S1, HP-DB2 | T5, `mss_db_query_duration_seconds{query="search_translation_exists"}` |
| FP-DB5 | cache gauges, T7 |
| HP-1, HP-DB1 | existing `mss_ingest_duration_seconds` (compare with and without the enqueue branch in the benchmark) |
| HP-2 | tokens and cost histograms |
| HP-3 | article route duration |
| HP-D1 | `mss_translation_validate_seconds` histogram (add, buckets 1 ms to 1 s) |

## 13. Implementation notes for the plan
- Benchmark and tests can read the ledger directly: `enrichment_jobs` where `part = 'translation'` by state, `article_translations` current rows, and the counters above through `/api/metrics`. No extra instrumentation is needed for completeness checks.
- Order of work: (1) add label keys `script`, `view` to the allow-list and the catalogue test; (2) enqueue and worker counters; (3) validators' reason counters; (4) ledger gauges and reconcile check; (5) page state counter and beacon route; (6) alert rules and Grafana row; (7) redaction test update for translation fields.
- carma-devops: no new service; add the alert rules and dashboard JSON to `ops/` so `docker compose up` provisions them; add `breaker.openai-translate` handling in `ops/alerts.yml`.
- Note the in-process registry resets on restart and is per process (`globalThis.__mssMetrics`); ledger-derived gauges are therefore computed from the database rather than accumulated in memory.

## 14. Decisions needed and open questions
- Proposed SLO numbers (30 min/6 h lag, 98% coverage, 5% rejection) are placeholders, UNCONFIRMED.
- Reveal-button beacon: build it or skip (section 8)? Default: build, it is small. UNCONFIRMED.
- Log sampling of `translation.accepted` above 20 jobs/s and log retention. UNCONFIRMED.
- Tail sampling for traces depends on the existing stack's capability. UNCONFIRMED.
