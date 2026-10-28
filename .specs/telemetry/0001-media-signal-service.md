---
spec: carma-telemetry
number: 0001
title: Observability plan for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/search/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
  - .specs/data/dba/0001-media-signal-service.md
principles: [P1, P2, P3, P6, P7, P8]
supersedes: null
---

# Telemetry

## 1. Summary

Recommended stack for the assignment: **structured JSON logs, a Prometheus-format `/metrics` endpoint on the web app and on the worker, health and readiness endpoints, a `/api/status` JSON endpoint with a small status page, a per-article trace endpoint, and a `Server-Timing` header on API responses.** All of it needs no extra containers, so it comes up with `docker compose up` and costs little to build. A Prometheus + Grafana pair with provisioned dashboards and alert rules is specified as an optional Compose profile (`observability`) and is a stretch item behind the cut line. OpenTelemetry tracing is documented, not built.

Three design points:

- **The ledger is the source of truth for completeness.** Counters can drift; the database tables (`ingest_events`, `enrichment_jobs`, `enrichments`, `llm_budget_ledger`) cannot. Gauges for backlog, state counts and budget are computed from the ledger by one place (the worker), so they are never double-reported and always reconcile with what a SQL query says.
- **Capture lag and processing lag are separate SLIs.** The sample articles were published in June and July 2026 and are loaded in October, so their "age" is months. The 15-minute target must be judged on processing time and on live batches only. Backfills are labelled and excluded.
- **No article text, ids or sources as metric labels, and no article text or keys in logs** (cardinality and data-sanity section 12).

## 2. Current observability

Greenfield: no logging, metrics, tracing, health checks or dashboards exist (architect spec section 3). Baseline recommended: `pino` JSON logs, `prom-client` for metrics, Prometheus naming (`mss_` prefix, base units in seconds and bytes), OpenTelemetry-compatible attribute names so tracing can be added later. `pg_stat_statements` is enabled by the DBA plan; it is read through a SQL view on the status page, not through an exporter, to avoid another container.

Gaps to avoid from the start: swallowed exceptions (data-sanity rule 3 requires a recorded reason for every failure), metrics nobody alerts on (each metric in section 4 names the alert or panel that uses it), readiness probes that check nothing.

## 3. SLIs and SLOs

Given targets: the 15-minute `published_at` to user target (Carma). **Everything else is proposed** and meant to be tuned with real data. At this scale the SLOs are measured and displayed, not enforced (ADR-0001).

| ID | Indicator | Definition and source | Proposed target | Alert | Owner |
| --- | --- | --- | --- | --- | --- |
| SLI-1 | Ingest reconciliation | For each completed batch: `received = admitted + quarantined + duplicate` (`ingest_events`) | Exactly equal, always | A1 | Data/ingest |
| SLI-2 | Capture lag | `articles.ingested_at - published_at` histogram, `batch_kind = live` only. Backfill batches excluded | Given: 95% of live mentions visible within 15 min of `published_at`, so p95 capture lag + searchable time under 15 min | A2b (growth) | Source/ingest |
| SLI-3 | Time to searchable | `ingested_at` to searchable. The vector is generated on insert, so this is the insert commit time | p99 under 1 s | none (structural) | DB |
| SLI-4 | Time to enriched | `enrichments.created_at - articles.ingested_at`, per part, excluding time spent `deferred_budget` | p95 under 5 min (proposed) | A2 | Pipeline |
| SLI-5 | Oldest actionable job age | Oldest `queued` / `failed_retryable` job, `deferred_budget` excluded (it is waiting by design) | Under 15 min | A2 | Pipeline |
| SLI-6 | Enrichment success | `succeeded / (succeeded + dead)` over 24 h, per part; skipped (no content) and deferred shown separately | At least 99% (proposed) | A6 | Pipeline |
| SLI-7 | Search / list / aggregate latency | Server-side request duration histograms | Search p95 under 500 ms, list p95 under 200 ms, aggregate p95 under 500 ms (proposed) | A8 | API |
| SLI-8 | API availability | Non-5xx share of requests (4xx parse errors are correct behaviour) | At least 99.5% over 7 days (proposed) | A8 | API |
| SLI-9 | Provider health | Per provider: call error ratio, breaker open time | Error ratio under 5%; breaker open under 1% of time (proposed) | A3, A4 | Pipeline |
| SLI-10 | Budget | `spent / cap` per provider per UTC day | Never above 100% (hard guard); warn at 80% | A5 | Cost owner |
| SLI-11 | Quarantine | Open items and oldest age | Zero older than 24 h | A7 | Data/ingest |
| SLI-12 | Confidence health | Share of derived values with origin `none` ("no confidence available") and distribution per field and origin | Missing share under 20% (proposed); drift reviewed weekly | A14 | Pipeline |

Burn judgement: for SLI-7 and SLI-8 use two windows (5 min and 1 hour) so a short spike pages and a slow burn tickets. At this traffic level the thresholds will be noisy; the rules file says so.

## 4. Metric catalogue

Prefix `mss_`. "Series" is the expected cardinality per process.

| Name | Type | Unit | Labels (cardinality) | Emitted by | Why | Serves |
| --- | --- | --- | --- | --- | --- | --- |
| `mss_ingest_items_total` | counter | items | `outcome` (3), `reason` (about 25 codes, empty for admitted) | loader/ingest | SLI-1 | FP-7, FP-8, FP-D3 |
| `mss_ingest_flags_total` | counter | items | `flag` (about 10) | ingest | Edge-case markers | FP-6, FP-D1, FP-D4 |
| `mss_ingest_transformations_total` | counter | transformations | `kind` (about 8) | ingest | Markup/Unicode repair visibility | FP-D1, FP-D2 |
| `mss_capture_lag_seconds` | histogram | s | `batch_kind` (live, backfill); buckets 60, 300, 900, 3600, 21600, 86400, 604800, 2.6e6, 3.2e7 | ingest | SLI-2 | P1 |
| `mss_ingest_batch_duration_seconds` | histogram | s | none | ingest | Loader speed | HP-DB1 |
| `mss_http_request_duration_seconds` | histogram | s | `route` (about 8), `method` (2), `status_class` (4); buckets 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5 | web | SLI-7, SLI-8 | HP-1, HP-2, HP-3 |
| `mss_search_phase_duration_seconds` | histogram | s | `phase` (parse, compile, execute, hydrate) | web | Where search time goes | HP-1, HP-S1, HP-S2 |
| `mss_search_parse_errors_total` | counter | errors | `code` (about 10) | web | Parser error spike, UX issues | FP-1, FP-2 |
| `mss_search_rejected_total` | counter | requests | `reason` (length, depth, leaves, wildcards, range) | web | Caps hit | FP-S12 |
| `mss_search_leaves_total` | counter | leaves | `kind` (fts, phrase, prefix, substring) | web | Leaf mix, index fit | HP-DB2 |
| `mss_search_empty_total` | counter | responses | `state` (no_match, not_covered, not_yet_enriched) | web | Honest empty states | FP-18, FP-S5 |
| `mss_db_query_duration_seconds` | histogram | s | `query` (named queries, about 20) | web, worker, loader | Hot query timing | HP-DB1 to HP-DB6 |
| `mss_db_pool_connections` | gauge | connections | `pool` (3), `state` (idle, busy, waiting) | all | Saturation | Resilience table |
| `mss_jobs` | gauge | jobs | `part` (2), `state` (7) | worker, from ledger | Backlog, SLI-5 | FP-9, FP-12 |
| `mss_job_oldest_age_seconds` | gauge | s | `part`, `state` (queued, failed_retryable, running, deferred_budget) | worker, from ledger | SLI-5, stuck jobs | FP-9 |
| `mss_job_outcomes_total` | counter | jobs | `part`, `outcome` (succeeded, retry, dead, deferred, skipped) | worker | SLI-6 | FP-10 to FP-13 |
| `mss_job_sweeper_released_total` | counter | jobs | none | worker | Crash recovery visibility | FP-9, FP-DB4, FP-DB5 |
| `mss_time_to_enriched_seconds` | histogram | s | `part`; buckets 1, 5, 15, 60, 300, 900, 3600 | worker | SLI-4 | P1 |
| `mss_provider_calls_total` | counter | calls | `provider` (2 plus mock), `outcome` (ok, timeout, rate_limited, server_error, client_error, invalid_output, breaker_open) | worker | SLI-9 | FP-12 |
| `mss_provider_call_duration_seconds` | histogram | s | `provider`; buckets 0.25, 0.5, 1, 2, 4, 8, 16, 30 | worker | Provider latency | HP-7 |
| `mss_provider_retries_total` | counter | retries | `provider`, `class` (transient, ambiguous) | worker | Retry storms | FP-12, FP-13 |
| `mss_provider_tokens_total` | counter | tokens | `provider`, `direction` (in, out) | worker | Cost, truncation effect | FP-13 |
| `mss_provider_cost_micro_total` | counter | micro-currency | `provider` | worker | Spend | FP-13 |
| `mss_breaker_state` | gauge | 0/1/2 | `provider` | worker | closed / half-open / open | FP-12 |
| `mss_budget_micro` | gauge | micro-currency | `provider`, `kind` (cap, reserved, spent) | worker, from ledger | SLI-10 | FP-14, FP-DB5 |
| `mss_budget_deferred_total` | counter | jobs | `provider` | worker | Budget exhausted effect | FP-13 |
| `mss_llm_cache_total` | counter | lookups | `result` (hit, miss) | worker | Duplicate savings | FP-13 |
| `mss_input_truncated_total` | counter | inputs | `provider` | worker | Token cap hits | FP-13 |
| `mss_output_validation_failures_total` | counter | failures | `provider`, `reason` (about 10) | worker | Injection and drift | FP-10, FP-11, FP-D9 |
| `mss_prompt_injection_suspected_total` | counter | articles | none | ingest/worker | Injection signal | FP-11, FP-D10 |
| `mss_confidence_norm` | histogram | 0 to 100 | `field` (3), `origin` (5); buckets every 10 | worker | SLI-12 drift | FP-D14, P6 |
| `mss_confidence_missing_total` | counter | values | `field`, `origin` | worker | "No confidence" share | P6 |
| `mss_quarantine_open` | gauge | items | none | worker, from ledger | SLI-11 | FP-D3, FP-D16 |
| `mss_quarantine_oldest_age_seconds` | gauge | s | none | worker, from ledger | SLI-11 | FP-D16 |
| `mss_enrichment_coverage_ratio` | gauge | ratio | `part` | worker, from ledger | Coverage numbers | FP-S5 |
| `mss_worker_heartbeat_timestamp_seconds` | gauge | s | none | worker | Worker liveness | FP-9 |
| `mss_build_info` | gauge (1) | n/a | `version`, `prompt_version`, `normaliser_version` | all | Reproducibility | P8 |
| default process metrics | various | various | none | all | CPU, memory, event loop lag | resilience |

About 300 to 600 series per process. **Never** a label on `article_id`, `source`, `external_id`, query text, topic or model output. `source` has 20 values in the sample but is unbounded in real feeds; it is a log field only. `language` could be a label (bounded), but is omitted to keep the catalogue small.

Notes:

- The `/metrics` registry in the Next.js server must be a process-wide singleton (store it on `globalThis`), otherwise development hot reload registers metrics twice and throws.
- Gauges derived from the ledger (`mss_jobs`, ages, budget, quarantine, coverage) are computed by **the worker only**, every 15 seconds, with one read query. The web app reads the same numbers for `/api/status` through a cached query (5 seconds).

## 5. Logs

Library: `pino`, JSON lines to stdout (Compose collects them). One line per event.

| Field | Meaning |
| --- | --- |
| `ts`, `level`, `msg` | Standard |
| `service` | `web`, `worker`, `loader` |
| `version` | Build/commit and `prompt_version`, `normaliser_version` |
| `request_id` | From `X-Request-Id` or generated, echoed in the response |
| `batch_id`, `job_id`, `article_id` | Correlation ids (logs only, never metric labels) |
| `stage` | `ingest`, `validate`, `sanitise`, `search`, `claim`, `provider_call`, `validate_output`, `settle`, `sweep` |
| `event` | `decision`, `state_change`, `retry`, `breaker`, `budget`, `quarantine`, `job_finished`, ... |
| `outcome`, `reason_code` | From the catalogue in data-sanity section 3 |
| `provider`, `attempt`, `duration_ms`, `tokens_in`, `tokens_out` | Provider calls |
| `rule`, `rule_version` | Decision records (what filtered, flagged or quarantined, and by which rule) |
| `err_class`, `err_message` | Scrubbed |

Levels: `info` for decisions, state changes and job summaries; `warn` for retries, breaker transitions, budget deferral, output validation failures; `error` for dead-lettered jobs and unexpected exceptions; `debug` off by default.

**Never logged:** headline, body, summary, prompt text, raw provider output, API keys, authorization headers, database passwords. Logs carry lengths, hashes and ids. Search queries: `query_len`, `query_sha256`, leaf count, depth and, on error, `error_code` and `position`; the query text itself only at `debug`. Redaction is configured in the logger (`redact` paths for headers and key fields) and tested.

**Decision records (P4, P8).** Each quarantine, flag, duplicate, truncation, injection suspicion and cache hit writes one line with `event=decision`, `rule`, `rule_version`. The same facts are in the database (`ingest_events`, `ingest_transformations`, `articles.flags`), so the logs add timing and context rather than being the only record.

**Confidence records (P7).** Origin, method, raw score, range and normalised value are stored in `derived_values`; logs do not duplicate them except at `debug`. A surprising confidence is traced from the database row through `enrichment_id` to the provider, model, prompt version and capped raw output.

**Volume.** Assignment scale is a few hundred lines in total. At 800/s: per-success `job_finished` lines would be about 1,600 lines a second, so they are sampled at 1% in the growth path; decisions, warnings and errors are never sampled.

## 6. Traces

Implemented: **correlation by ids**, not distributed tracing. `request_id` is on every web log line and in the response header; `job_id` and `batch_id` link worker and loader lines; the per-article trace endpoint (section 9) joins them from the database.

Documented (not built): OpenTelemetry SDK with these spans: web `http.request` > `search.parse` > `search.compile` > `db.query`; worker `job.claim` > `provider.call` > `validate_output` > `db.write`. Attributes use the same names as the log fields. Sampling: 100% at assignment scale; in the growth path, head sampling 5% plus tail sampling to keep every error and every request over 2 s.

## 7. Request and response times

| Interface | Measured as | Buckets | Notes |
| --- | --- | --- | --- |
| `GET /api/search` (list with query) | `mss_http_request_duration_seconds{route="search"}` and per phase | 5 ms to 5 s | `Server-Timing: parse;dur=, compile;dur=, db;dur=, hydrate;dur=` header on the response |
| `GET /api/articles` (list) | same | same | Keyset page |
| `GET /api/aggregate` | same | same | Plus `Server-Timing` |
| `GET /api/articles/{id}/trace` | same | same | Developer view |
| `GET /api/status`, `/api/healthz`, `/api/readyz` | same | same | Excluded from SLI-8 |
| jev call | `mss_provider_call_duration_seconds{provider="jev"}` | 0.25 s to 30 s | Per attempt, outcome-labelled |
| OpenAI call | same | same | Includes time to first byte only if streaming is used (it is not) |
| Named DB queries | `mss_db_query_duration_seconds{query}` | 1 ms to 5 s | list, aggregate_week, aggregate_month, claim, finish, budget_reserve, ingest_batch, status |

`Server-Timing` exposes only phase durations, not SQL or internals.

## 8. Alerts and runbook pointers

All thresholds are **proposed**. At this scale they are expressed as a Prometheus rules file (`ops/alerts.yml`, loaded by the optional `observability` profile) and, without Prometheus, as red/amber badges on the status page driven by the same conditions.

| ID | Condition | Severity | First check |
| --- | --- | --- | --- |
| A1 | A completed batch where `received != admitted + quarantined + duplicate` | Page | Run the reconciliation query (DBA spec section 10) for `batch_id`; look for loader crash lines |
| A2 | `mss_job_oldest_age_seconds{state=~"queued\|failed_retryable"} > 900` for 5 min | Page | Worker heartbeat, breaker state, provider status, claim query |
| A2b | Live-batch p95 capture lag + time to searchable above 15 min for 15 min | Page (growth) | Source feed delay vs ingest delay: compare `published_at` to `ingested_at` |
| A3 | `mss_breaker_state == 2` for 10 min | Ticket | Provider status page; recent error classes |
| A4 | Provider error ratio above 20% over 10 min and above 5% over 1 h | Page / ticket | `mss_provider_calls_total` by outcome: 429 (rate limit), 5xx, timeouts |
| A5 | Budget remaining under 20% (warn); exhausted (info, expected) | Warn | `mss_budget_micro`, `mss_budget_deferred_total`; when the UTC reset happens |
| A6 | More than 5 jobs dead in 1 h, or `invalid_output` above 10% of attempts | Ticket | Output validation reasons; injection counter; prompt version change |
| A7 | Quarantine item open longer than 24 h | Ticket | Reason codes; replay after the rule fix |
| A8 | Search p95 above 500 ms for 10 min, or 5xx above 1% for 5 min | Page | Phase histogram (parse / compile / execute); `EXPLAIN` of the slow query; pool saturation |
| A9 | Over 50% of search requests are parse errors for 10 min | Warn | Error codes; a UI bug or a new query pattern |
| A10 | Injection-suspected above 5% of ingested articles in 1 h | Warn | A source campaign; flagged articles list |
| A11 | Pool waiting connections above 0 for 5 min, disk above 80%, dead tuples on `enrichment_jobs` high | Warn | Slow queries in `pg_stat_statements`; autovacuum |
| A12 | Worker heartbeat older than 2 min | Page | Container state; logs; claim loop |
| A13 | `enrichment_enabled = false` for over 1 h | Warn | Kill switch left on |
| A14 | "No confidence available" share above 20% | Ticket | Provider response shape change |

Runbook entries (written in the README or `docs/runbook.md` in the plan):

- **Stuck job:** `SELECT * FROM enrichment_jobs WHERE state='running' AND claim_expires_at < now()`; the sweeper should release it within a minute; if not, check the sweeper log and run it by hand; confirm `reserved_micro` returned.
- **Budget exhausted:** expected; jobs are `deferred_budget` with `next_attempt_at` at the next UTC midnight; raise the cap in configuration and restart, or wait. Nothing is lost.
- **Provider outage:** breaker opens; jobs stay queued; the UI shows "enrichment paused"; confirm recovery by the half-open probe; backlog drains at the rate limit.
- **Injection flagged:** list articles with the flag; confirm derived values show `trust = low`; review validator failures.
- **Parser error spike:** group `mss_search_parse_errors_total` by code; reproduce with the echoed `parsed` field.
- **Reconciliation mismatch:** find the batch, compare file item count with events, inspect loader errors; quarantine rows prove no silent loss.

## 9. Dashboards

Implemented as the **status page** (`/status`) plus JSON `/api/status`; the Grafana version (optional profile) shows the same panels from Prometheus.

**Infra view:** SLO status tiles (SLI-1 to SLI-12 with green/amber/red); ingest reconciliation per recent batch; capture lag histogram (live vs backfill); time to enriched p50/p95; jobs by state per part; oldest job age; per-provider call rate, error ratio, latency, tokens, cost; breaker state; budget used vs cap per provider; quarantine open and oldest; search/list/aggregate latency and error rate; DB pool and size; coverage ratios.

**Developer view:** per-phase search latency; reason-code breakdowns (quarantine, parse errors, validation failures); **article lookup** (`/api/articles/{id}/trace`): the article's flags, ingest event, transformations, jobs with states and attempts, enrichments with provider/model/prompt version/origin/trust/cost, derived values with confidence origin and range, and cache hit or not. This is the "what happened to article N" query (P8) and doubles as a demo of traceability.

**`/api/status` response and the "is this complete?" numbers:**

| Field | Source | Meaning |
| --- | --- | --- |
| `articles_total` | `count(*) FROM articles` | Corpus size |
| `ingest.unreconciled_batches` | Batches where events differ from file count | Should be 0 |
| `jobs` | Counts by `part` and `state` | Pipeline state |
| `oldest_actionable_job_age_s` | As SLI-5 | Freshness of enrichment |
| `watermark.latest_published_at`, `watermark.latest_ingested_at` | `max()` over `articles` | What the corpus can see |
| `coverage.enriched_sentiment`, `coverage.enriched_topics` | Counts of articles with a current value | Enrichment coverage |
| `quarantine_open` | Open quarantine rows | Known gaps |
| `budget` and `breaker` per provider | Ledger and worker-written status keys | Why enrichment may be paused |
| `complete` | `unreconciled_batches = 0 AND queued + running + failed_retryable + deferred_budget = 0` | True when everything admitted has been fully processed |
| `gaps` | `dead + skipped_no_content + quarantine_open` | Items that will not be enriched or were held back, reported, never hidden (P3) |

The `coverage` object inside search, list and aggregate responses (search spec section 8) uses the same definitions, filtered to the request's scope, so a chart and the status page cannot disagree.

**Health endpoints.** Web: `/api/healthz` (process only), `/api/readyz` (database reachable within 1 s with `app_read`, and the latest migration applied; 503 otherwise). Worker: `/healthz` (loop heartbeat within 60 s), `/readyz` (database reachable). **Readiness never depends on a provider**: a provider outage degrades enrichment, it must not take the search UI out of service (P3).

## 10. Overhead and cardinality budget

- Metrics: 300 to 600 series per process, scraped every 15 s: negligible. Unbounded labels are excluded by rule and by a unit test that fails if a metric uses a label outside an allow-list.
- Logs: assignment scale is hundreds of lines. Growth path at 800/s: only decisions, warnings and errors always; `job_finished` sampled at 1% gives under 20 lines a second plus decisions; estimated well under 1 MB a minute. `UNCONFIRMED` until measured.
- Ledger gauges: one read query every 15 s (counts by state with the partial indexes, plus a few `min()`s); cost is trivial at this size and is the first thing to rewrite (approximate counts or maintained counters) at 800/s.
- Traces (growth path): sampled as in section 6.
- Retention (proposed): logs 7 days in Compose (Docker log rotation, 10 MB x 3 files per service); Prometheus 7 days if the profile is used.

## 11. Coverage of the architect registers

| Registers | Detected by |
| --- | --- |
| FP-1, FP-2, FP-S1, FP-S12 (parser) | `mss_search_parse_errors_total`, `mss_search_rejected_total`, golden tests |
| FP-3, FP-D7 (injection) | Static/lint checks (not runtime); DB error rate in `mss_http_request_duration_seconds{status_class="5xx"}` |
| FP-4, FP-5, FP-S2, FP-S10, FP-S11 (language search) | `mss_search_leaves_total`, golden tests, `EXPLAIN` experiment E1 |
| FP-6, FP-D1, FP-D2, FP-D8, FP-D9 (XSS, markup) | `mss_ingest_transformations_total`, `mss_ingest_flags_total`, UI render test |
| FP-7, FP-8, FP-D3, FP-D4, FP-D5, FP-D6 (ingest loss) | `mss_ingest_items_total`, SLI-1, A1 |
| FP-9, FP-DB4, FP-DB5 (stuck jobs, leaked reservation) | `mss_job_oldest_age_seconds{state="running"}`, `mss_job_sweeper_released_total`, A2, A12 |
| FP-10, FP-11, FP-D10, FP-D11 (output, injection) | `mss_output_validation_failures_total`, `mss_prompt_injection_suspected_total`, A6, A10 |
| FP-12 (provider outage) | `mss_provider_calls_total`, `mss_breaker_state`, A3, A4 |
| FP-13, FP-14, FP-D12 (cost, budget race) | `mss_provider_cost_micro_total`, `mss_budget_micro`, `mss_llm_cache_total`, A5 |
| FP-15, FP-16, FP-S6, FP-S7, FP-S8, FP-DB10 (list, aggregate) | Test-time checks (conservation, drill-through); not runtime signals |
| FP-17, FP-D15 (mock shown as model) | `mss_provider_calls_total{provider="mock"}`; origin on every row |
| FP-18, FP-S5 (not-yet-enriched) | `mss_search_empty_total{state}`, `mss_enrichment_coverage_ratio` |
| FP-D13 (key leak) | Bundle scan and log redaction tests (not runtime) |
| FP-D14 (confidence misread) | `mss_confidence_norm`, `mss_confidence_missing_total` |
| FP-D16 (quarantine ignored) | `mss_quarantine_open`, `mss_quarantine_oldest_age_seconds`, A7 |
| FP-DB1, FP-DB2, FP-DB3, FP-DB7 (migrations, roles, extensions) | `/api/readyz` migration check; startup log of capabilities; grant tests |
| FP-DB6 (normaliser version) | `mss_build_info{normaliser_version}`; backfill query on `search_text_ver` |
| FP-DB8, FP-DB9, HP-DB1 to HP-DB6 | `mss_db_query_duration_seconds{query}`, `pg_stat_statements` view |
| HP-1 to HP-3, HP-S1 to HP-S3 | Phase histograms, `Server-Timing` |
| HP-4, HP-5, HP-D1, HP-D4 | `mss_ingest_batch_duration_seconds`, unit timing tests |
| HP-6, HP-DB4, HP-DB5 | `mss_jobs`, claim and budget query histograms |
| HP-7, HP-D3 | `mss_provider_call_duration_seconds`, tokens, cost |

## 12. Implementation notes for the plan

**Stack components.** Option A needs none beyond the app, worker and database. Optional profile `observability`: `prometheus` (scrapes `web:3000/api/metrics` and `worker:9101/metrics`, 7-day retention, about 50 MB), `grafana` (provisioned datasource and a dashboard JSON committed to the repository, anonymous viewer enabled for local use), rule file `ops/alerts.yml`. Both run only with `--profile observability`.

**What a quick benchmark can read** without extra instrumentation (carma-benchmark): `ingest_events` counts by `outcome` per `batch_id`; `enrichment_jobs` counts by state; `enrichments.created_at - articles.ingested_at` for time to enriched; `llm_budget_ledger`; `/api/status`.

**Build order** (each step usable on its own):
1. Logger with redaction, `request_id` middleware, `X-Request-Id` and `Server-Timing` helpers.
2. Metrics registry (singleton), HTTP middleware, `/api/metrics`.
3. Health and readiness endpoints (web, worker).
4. Ingest counters and the reconciliation check; capture lag histogram with `batch_kind`.
5. Search phase timers and parse/reject counters; empty-state counters.
6. Worker ledger gauges (single writer), job outcome counters, heartbeat, sweeper counter.
7. Provider wrappers (calls, latency, retries, tokens, cost, breaker, cache, validation failures, injection counter); budget gauges.
8. `/api/status`, `/api/articles/{id}/trace`, `/status` page.
9. Optional: Prometheus rules and Grafana dashboard.

**Two small changes the DBA spec needs** (applied to `.specs/data/dba/0001-media-signal-service.md`): an `ingest_events.batch_kind` column (`live` or `backfill`), and write access for `app_worker` to `system_flags` keys prefixed `worker.` and `breaker.` (heartbeat and breaker state for the status page), so that `app_read` can read them.

## 13. Decisions needed and open questions

| ID | Decision | Options (recommended first) |
| --- | --- | --- |
| T1 | Observability stack for the submission | (a) JSON logs + `/metrics` + status page + trace endpoint, no extra containers; Prometheus/Grafana as an optional profile if time remains. (b) Build Prometheus + Grafana with provisioned dashboards as part of the core deliverable (adds about 1 to 1.5 hours). (c) Logs and status page only |

Held defaults (not asked): SLO numbers in section 3 and thresholds in section 8 are proposed; log retention 7 days; `Server-Timing` header on; no OpenTelemetry in this build.

Open questions: does the grader's environment have a port available for Grafana (affects T1 b)? Is a `/status` page in the UI acceptable, or should it be API-only? `UNCONFIRMED`.
