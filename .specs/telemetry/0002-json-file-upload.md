---
spec: carma-telemetry
number: 0002
title: Telemetry for the JSON upload and article versioning
status: draft
date: 2026-10-24
feature: json-file-upload
inputs: [.specs/architect/0002-json-file-upload.md, .specs/data/sanitization/0002-json-file-upload.md, .specs/data/dba/0002-json-file-upload.md, .specs/telemetry/0001-media-signal-service.md, .specs/architect/adrs/0014-observability-stack.md]
principles: [P2, P3, P8]
supersedes: null
---

# 0002 Telemetry for the JSON upload and article versioning

## 1. Summary
No new tools. The upload adds one write endpoint to the web process, so the existing stack (pino logs, hand-rolled Prometheus registry at `src/lib/metrics.ts` served by `/api/metrics`, Prometheus rules in `ops/alerts.yml`, Grafana in `ops/grafana`) is extended with an `mss_upload_*` family, a few version counters, two alerts and one dashboard row. The key indicator is **reconciliation**: every received element must be accounted for, and any mismatch is an alert (P2, P3).

## 2. Current observability
- Metrics registry `src/lib/metrics.ts` allows only these label keys: `provider, part, outcome, state, method, code, origin`; any other key throws at runtime (`labelKey`). Telemetry 0001 plans labels such as `reason`, `route`, `kind`, `phase` that are not in the allow-list yet. Finding: add the new keys (`reason`, `route`, `status_class`) to `ALLOWED_LABEL_KEYS` in the same task, or use `code` for reasons.
- Registry is per process and held on `globalThis`, so web-side upload counters are scraped from the web instance; worker gauges stay in the worker.
- Logs: pino with a redact list (`src/lib/log.ts`) that covers `authorization` headers and `password`, but not an `x-upload-token` header or a `token` field. Gap: add them before the route exists.
- Health: `/api/readyz`, `/api/healthz`, `/api/status` exist; upload readiness (token configured, ingest pool reachable) is not reported.

## 3. SLIs and SLOs
| SLI | Definition | Target (proposed unless marked) | Alert |
| --- | --- | --- | --- |
| U-SLI-1 Reconciliation | per upload, `received == admitted + duplicate + quarantined` | 100%, counter `mss_upload_reconcile_mismatch_total` stays 0 | U1 page |
| U-SLI-2 Upload success | share of authorised, well-formed uploads returning 2xx | 99% over 7 days | U2 ticket |
| U-SLI-3 Upload latency | request duration for files at the cap | p95 under 30 s, hard deadline 60 s | U3 warn |
| U-SLI-4 Time to enriched for uploaded articles | existing `mss_time_to_enriched_seconds`; budget deferrals excluded | none new; reported separately for batch kind `backfill` | existing A2/A5 |
| U-SLI-5 Version integrity | `superseded_version` jobs never leave a `running` job older than the claim timeout, no stale current enrichment | 0 stale | U4 ticket |
The 15-minute freshness target applies to live batches only; uploads are `backfill` and are excluded from the live freshness SLI (architect FP-11), which the metric labels must preserve (`mss_capture_lag_seconds{batch_kind="backfill"}`).

## 4. Metric catalogue (new)
| Name | Type | Unit | Labels (cardinality) | Where | Serves |
| --- | --- | --- | --- | --- | --- |
| `mss_upload_requests_total` | counter | requests | `outcome` (ok, rejected, error), `status_class` (4) | web route | U-SLI-2; FP-1, FP-2, FP-9 |
| `mss_upload_rejected_total` | counter | requests | `reason` (about 12: unauthorized, upload_busy, rate_limited, unsupported_media_type, file_too_large, invalid_encoding, not_an_array, too_many_items, too_deep, empty_file, upload_disabled, db_unavailable) | web route | sanity section 3; FP-1, FP-2, FP-D1 |
| `mss_upload_items_total` | counter | items | `outcome` (admitted, duplicate, quarantined) | web route | U-SLI-1 |
| `mss_upload_versions_total` | counter | items | `outcome` (new_version, unchanged) | web route | FP-DB1, ADR-0021 |
| `mss_upload_reconcile_mismatch_total` | counter | uploads | none | web route | FP-12, FP-D4 |
| `mss_upload_bytes` | histogram | bytes | none; buckets 1e4, 1e5, 5e5, 1e6, 2.5e6, 5e6 | web route | HP-2 |
| `mss_upload_items` | histogram | items | none; buckets 1, 10, 50, 100, 250, 500, 1000 | web route | HP-1 |
| `mss_upload_duration_seconds` | histogram | s | none; buckets 0.1, 0.5, 1, 2.5, 5, 10, 30, 60 | web route | U-SLI-3, HP-1 |
| `mss_upload_in_flight` | gauge | requests | none | web route | FP-8 |
| `mss_upload_parse_duration_seconds` | histogram | s | none; buckets 0.005 to 1 | web route | HP-2 |
| `mss_event_loop_lag_seconds` | gauge | s | none | web (`perf_hooks.monitorEventLoopDelay`) | HP-D1 |
| `mss_jobs{state="superseded_version"}` | existing gauge | jobs | existing `part`, `state` | worker from ledger | FP-DB2, FP-DB3 |
| `mss_job_outcomes_total{outcome="superseded"}` | existing counter | jobs | add `superseded` value | worker | FP-DB2 |
| `mss_db_query_duration_seconds{query="ingest_new_version"}` and `{query="upload_batch_status"}` | existing histogram | s | new `query` values | web | HP-DB1, HP-DB2 |
| `mss_db_pool_connections{pool="web-ingest"}` | existing gauge | connections | new `pool` value | web | FP-8 |
| `mss_db_lock_wait_seconds` | histogram | s | none | web ingest, worker | FP-DB6 |
Cardinality: all new label sets are small (under 20 series per metric). `batch_id`, `source`, `article_id`, filenames and tokens are never labels.

## 5. Logs
One log line per upload at the end (info), plus one per rejection (warn):
`{event:"upload", batch_id, outcome, status, bytes, items, admitted, duplicate, quarantined, new_versions, reconciled, duration_ms, file_sha256}`.
Per element: nothing on success. Quarantine and version decisions are already in the ledger (`ingest_events` with `reason_codes`, `article_version`), which is the per-article trail: "what happened to article 4711" stays one query by `article_id`, now including `article_versions`.
Never logged: file text, article text, filename (raw), token, `Authorization`/`x-upload-token` headers. Add `x-upload-token`, `headers["x-upload-token"]`, `token` to `REDACT_PATHS`. Correlation: the response returns `batch_id`; the UI shows it so a user can quote it (developer lookup).

## 6. Traces
No tracing stack exists (telemetry 0001 section 6 is attribute naming only). Span names if traces are added later: `upload.request` with attributes `batch_id`, `upload.bytes`, `upload.items`, `upload.outcome`; child `upload.parse`, `upload.ingest_loop`, `db.ingest_new_version`. No article text in attributes.

## 7. Request and response times
| Interface | Metric | Buckets | Notes |
| --- | --- | --- | --- |
| `POST /api/uploads` | `mss_http_request_duration_seconds{route="uploads"}` plus `mss_upload_duration_seconds` | 0.1 to 60 s | `Server-Timing: gate;dur=, parse;dur=, ingest;dur=` |
| `GET /api/uploads/:batchId` | `mss_http_request_duration_seconds{route="upload_status"}` | 5 ms to 5 s | polled by the UI; query plan check E6 |
| Upload page | no server metric | n/a | browser-side timing is out of scope |

## 8. Alerts and runbook pointers
| ID | Condition | Severity | First check |
| --- | --- | --- | --- |
| U1 | `increase(mss_upload_reconcile_mismatch_total[1h]) > 0` | Page | Response/log of the batch (`batch_id`); `ingest_events` count by outcome for that batch; look for a swallowed error between item loop and counts |
| U2 | upload 5xx ratio above 5% over 30 min | Ticket | `mss_upload_rejected_total{reason="db_unavailable"}`, DB health, ingest pool usage |
| U3 | `histogram_quantile(0.95, mss_upload_duration_seconds) > 30` over 1 h | Warn | `mss_upload_items`, DB statement timings, event-loop lag |
| U4 | `mss_jobs{state="running"}` with `mss_job_oldest_age_seconds{state="running"}` above claim timeout plus 5 min, or any current enrichment whose `article_version` differs from `articles.version` (ledger query) | Ticket | Sweeper log; version check in finish path (DBA E5) |
| U5 | `mss_upload_rejected_total{reason="unauthorized"}` above 20 in 10 min | Warn | Source IPs from the proxy log; rotate the token (ADR-0020) |
Existing A2 and A5 continue to cover the enrichment lag and LLM budget after a large upload (expected: `deferred_budget` after a 1000-item file).

## 9. Dashboards
Infra view: add an "Uploads" row: request rate by outcome, rejections by reason, duration p50/p95, in-flight, reconcile mismatch (single stat, must be 0), ingest pool usage. Developer view: add a batch lookup (links to `/api/uploads/:batchId`), per-batch outcome table (data source is the API, not Prometheus), versions created, `superseded_version` jobs. Update the files in `ops/grafana` (provisioned, so they come up with `docker compose up`).

## 10. Overhead and cardinality budget
Uploads are at most a few per hour at assignment scale, so overhead is negligible: about 15 new series, one log line per upload. Event-loop lag sampling every 5 s is the only continuous cost.

## 11. Coverage of the registers
| ID | Signal |
| --- | --- |
| FP-1, FP-2 | `mss_upload_rejected_total{reason}` |
| FP-3, FP-12, FP-D4 | `mss_upload_items_total`, `mss_upload_reconcile_mismatch_total` (U1) |
| FP-4, FP-5 | `mss_upload_requests_total{outcome="error"}`, batch lookup vs response |
| FP-6 | `mss_upload_items_total{outcome="duplicate"}`, `mss_upload_versions_total{outcome="unchanged"}` |
| FP-7 | existing `mss_budget_deferred_total` (A5) |
| FP-8, HP-D1 | `mss_upload_in_flight`, pool gauge, event-loop lag, search p95 |
| FP-9, FP-D2 | `mss_upload_rejected_total{reason="unauthorized"}` (U5), redaction test |
| FP-10 | existing `mss_prompt_injection_suspected_total`, ingest flags |
| FP-11 | `mss_capture_lag_seconds{batch_kind}` split; test asserts uploads are `backfill` |
| FP-D1 | `mss_upload_bytes`, container memory |
| FP-D3 | rejected without rows: assert `ingest_events` unchanged (test, not telemetry) |
| FP-D5, FP-DB1 | `mss_upload_versions_total{outcome="new_version"}` vs `count(article_versions)` |
| FP-DB2, FP-DB3 | U4, `mss_job_outcomes_total{outcome="superseded"}`, `mss_budget_micro{kind="reserved"}` returning to 0 |
| FP-DB6 | `mss_db_lock_wait_seconds` |
| HP-1 | `mss_upload_duration_seconds`, `mss_upload_items` |
| HP-2 | `mss_upload_parse_duration_seconds`, `mss_upload_bytes` |
| HP-3 / HP-DB2 | `mss_db_query_duration_seconds{query="upload_batch_status"}` |

## 12. Implementation notes for the plan
1. Extend `ALLOWED_LABEL_KEYS` (`reason`, `route`, `status_class`) and the log redaction list.
2. Add the `mss_upload_*` metrics in the route handler and the `mss_event_loop_lag_seconds` sampler (web only).
3. Add rules U1 to U5 to `ops/alerts.yml`; extend dashboards in `ops/grafana`.
4. Worker: emit `superseded` outcome and the version-discard counter.
5. Benchmark use (carma-benchmark): completeness without extra instrumentation = the upload response (`received`, per-outcome counts, `reconciled`) and `ingest_events` by `batch_id`; versions = `count(article_versions)` and `articles.version`; freshness for uploads is not applicable. Devops: no new containers; Prometheus must scrape the web `/api/metrics` (already configured in `ops/prometheus.yml`, verify the web target is present).

## 13. Decisions needed and open questions
- UNCONFIRMED: SLO figures in section 3 and alert thresholds are proposals.
- Open: should the batch lookup page be linked from the infra dashboard (needs the token for the API)? UX to decide.
- Open: `/api/metrics` is unauthenticated today; it will expose `mss_upload_*` counts, which contain no sensitive data.
