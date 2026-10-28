---
spec: carma-telemetry
number: 0004
title: Telemetry for stemmed and substring search and English-first display
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/search/0003-english-first-substring-search.md, .specs/data/dba/0004-english-first-substring-search.md, .specs/telemetry/0003-article-translation.md]
principles: [P1, P3, P7]
supersedes: null
---

# 0004 Telemetry for stemmed and substring search and English-first display

## 1. Summary
Additive to telemetry 0003. No new tool, no new service. Four things to see: (a) search latency by how a term was matched, (b) whether quotes and the new default are used, (c) the health of the two new indexes, (d) how often English-first falls back to the original and whether readers open the original text. All series reuse the in-process registry and the existing label allow-list.

## 2. Current observability
Reused as in telemetry 0003 section 2: registry with an allow-listed label set (`src/lib/metrics.ts`, guard test `tests/unit/metrics-labels.test.ts`), Prometheus rules `ops/prometheus.yml`, `ops/alerts.yml`, Grafana in `ops/grafana/`, structured redacted logs (`src/lib/log.ts`). Existing: `mss_db_query_duration_seconds{query}`, `mss_search_matches_total{kind}`, `mss_translation_view_total{view}` posted by `navigator.sendBeacon` to `src/app/api/telemetry/translation-view/route.ts` (accepts only `translated` or `original`, drops the rest and counts `mss_ui_event_dropped_total`), `mss_translation_page_state_total{state}`, `mss_search_foreign_untranslated`.
Gap: nothing says which kind of term a slow search used, and the plan-regression risk (HP-S1, HP-DB2) has no signal outside a test.

## 3. SLIs and SLOs
All proposed (Carma gave none beyond the 15-minute freshness target, which this change does not touch).
| SLI | Definition | Source | Proposed target | Alert | Owner |
| --- | --- | --- | --- | --- | --- |
| E-SLI-1 Search latency by term kind | p95 of list-search duration, split by the broadest term kind in the query (`exact`, `stem_sub`, `nonlatin_sub`) | `mss_search_duration_seconds{kind}` (existing T-SLI-5 series, new label values) | p95 under 1 s and within +25% of the pre-change baseline for `exact`; under 2 s (the read timeout) for `stem_sub` | E1 | Backend |
| E-SLI-2 Search timeouts | statement timeouts per 1,000 searches | `mss_search_timeouts_total` / searches | under 1% over 1 day | E2 | Backend |
| E-SLI-3 Index validity | both new indexes exist and are valid | `mss_search_index_valid{index}` gauge (1/0) | always 1 after migration | E3 (page) | Backend |
Ingest freshness SLO is unchanged and must not regress (E1 experiment in DBA 0004 guards the write cost).

## 4. Metric catalogue (additions)
Label keys needed: `kind` already allowed; new values only. New keys: none. (`index` below reuses the existing `query` key to avoid editing the allow-list: value is the index short name; two values.)
| Name | Type | Unit | Labels (cardinality) | Where | Serves |
| --- | --- | --- | --- | --- | --- |
| `mss_search_duration_seconds` | histogram | s | `kind` gains `exact`, `stem_sub`, `nonlatin_sub` (3 new values) | search route | E-SLI-1; HP-S1, HP-DB2 |
| `mss_search_terms_total` | counter | terms | `kind` (`exact`, `stem_sub`, `nonlatin_sub`, `short_stem`; 4) | compiler, once per leaf per query | share of quoted versus default terms; FP-S6 |
| `mss_search_empty_stem_total` | counter | terms | none | compiler, when a stop-word-only term falls back | FP-S7, FP-DB5 |
| `mss_search_zero_results_total` | counter | searches | `kind` (3 values as above) | search route | zero-result rate by term kind; P3 |
| `mss_search_timeouts_total` | counter | searches | none | search route | E-SLI-2 |
| `mss_search_index_valid` | gauge | 0/1 | `query` (`articles_fts_en`, `translations_fts_en`) | status refresher, `pg_index.indisvalid` | FP-DB2, FP-S9 |
| `mss_search_index_bytes` | gauge | bytes | `query` (same two values) | status refresher, `pg_relation_size` | HP-DB1 growth |
| `mss_search_gin_pending_bytes` | gauge | bytes | `query` (same two values) | status refresher, `pgstatginindex().pending_pages` | E8 soak |
| `mss_card_headline_source_total` | counter | cards | `state` (`english`, `original_pending`, `original_untranslatable`, `original_native`; 4) | cards, via the search API response, counted server-side per returned row | FP-7, D4, P3 |
| `mss_translation_view_total` | counter | events | `view` gains `original_shown` and `original_hidden`; `translated`, `original` are retired once the swap toggle is replaced | beacon route | reveal usage (FP-9) |
The beacon route's enum check must be updated to the new values, otherwise events are silently dropped as `bad_view`. Keep the old values accepted for one release so a cached client does not lose events.

A plan-regression guard, not a metric: the DBA 0004 E6 test asserts EXPLAIN uses both new indexes. Production sees a regression as E-SLI-1 for `stem_sub` rising with `mss_search_index_valid = 1`.

### 4.1 Amendment A (ADR-0035)
- `mss_search_matches_total{kind}` gains `summary`, `translation_summary`, `original_summary` (kind values only; `original`, `translation`, `both` stay).
- `mss_search_index_valid` and `mss_search_index_bytes` and `mss_search_gin_pending_bytes` gain `query` values `summary_fts_en` and `summary_trgm` (four indexes in all; still bounded).
- `mss_search_summary_missing` gauge: current articles in scope with no current summary (from the enrichment ledger, refreshed with the status refresher); serves the new coverage line.
- Overhead: still under 50 new series.

### 4.2 Amendment B (2026-10-28, ADR-0036)
Term kinds are now `exact` (bare and quoted), `wildcard`, `nonlatin_sub`; `stem_sub` and `short_stem` are removed. `mss_search_duration_seconds{kind}` and `mss_search_zero_results_total{kind}` use the three kinds, and E-SLI-1 targets read: `exact` p95 unchanged versus baseline; `wildcard` under 2 s (proposed under 1 s). `mss_search_terms_total` gains the share of wildcard terms. The `mss_search_index_*` series list four indexes: `articles_fts_en`, `translations_fts_en`, `summary_fts_en`, `summary_fts` (the `summary_trgm` value is dropped). `mss_search_empty_stem_total` counts stop-word wildcards. Alert E1 uses `wildcard`, not `stem_sub`. The trigram-off and "plan-regression for bare terms" cases are no longer Latin concerns.

## 5. Logs
Reuse the existing search log event; add fields only, never the query text (queries can contain brand names; keep the existing redaction rule):
| Event | Level | Added fields |
| --- | --- | --- |
| `search.done` | info, sampled 10% for success, always for timeout or error | `term_kinds` (counts per kind), `quoted_terms` (count), `duration_ms`, `result_count`, `matched_in` totals |
| `search.stem_empty` | warn, sampled 1% | `term_count` (not the term) |
| `migrate.index_invalid` | error | `index` |
No article text, headline or excerpt is logged for the English excerpt.

## 6. Traces
No spans added. If a search span exists, add attributes `term_kinds` and `quoted_terms`. Tail sampling already keeps slow or failed requests.

## 7. Request and response times
Search route: existing `mss_http_request_duration_seconds{route}`; buckets must cover 0.05 s to 2 s (the read timeout), since `stem_sub` is the new slow case. Article page and search API unchanged in routes; the added `body_excerpt_en` field is measured by DBA 0004 E7, not by a separate series.

## 8. Alerts and runbook pointers
| Alert | Condition | First check |
| --- | --- | --- |
| E1 | `stem_sub` p95 over 2 s for 15 minutes, or `exact` p95 over +25% baseline | `mss_search_index_valid`; EXPLAIN for the slow query shape (HP-DB2); GIN pending size |
| E2 | timeouts over 1% for 15 minutes | Same; recent migration or index rebuild; `trgm_index` flag |
| E3 | either index invalid for 5 minutes | Drop and re-create concurrently (DBA 0004 section 4); app still works through the substring branch, only slower |
| Info | `mss_search_gin_pending_bytes` rising for 1 hour | Vacuum activity, `gin_pending_list_limit` |

## 9. Dashboards
Infra view: add a "Search" row: p95 by term kind, timeouts, index validity and size, GIN pending. Developer view: term-kind mix, share of quoted terms, zero results by kind, headline source state mix, reveal events.

## 10. Overhead and cardinality budget
All new series have at most 4 label values, no per-source or per-article labels; total new series fewer than 40. Counters increment once per search or per returned card (at most about 50 per search); gauges refresh with the existing 60 s status refresher (three cheap catalogue queries). Logging adds fields to an existing sampled event. Negligible beside the 800/s ingest.

## 11. Coverage of the architect registers
| ID | Signal |
| --- | --- |
| FP-1 (over-trim) | `mss_search_terms_total`, golden tests (not detectable in production) |
| FP-2, FP-S5 (stem path missing) | zero-result rate by kind; tests |
| FP-3 (short term scan) | `mss_search_duration_seconds` for `short_stem` terms via `kind`; E5 |
| FP-4 (trigram off) | existing `trgm_index` flag, E1 latency |
| FP-5 (ILIKE metacharacters) | tests |
| FP-6 (stale translation) | existing `mss_translation_stale_current` |
| FP-7 (blank primary line) | `mss_card_headline_source_total` plus a UI test |
| FP-8, FP-S6 (quoted broadened) | `mss_search_terms_total{kind="exact"}` against result counts in tests |
| FP-9 (reveal unreachable) | `mss_translation_view_total{view="original_shown"}` nonzero; keyboard test |
| FP-S7, FP-DB5 (stop-word-only) | `mss_search_empty_stem_total` |
| FP-S9, FP-DB1, FP-DB2 | `mss_search_index_valid`, E-SLI-1 |
| HP-1, HP-S1, HP-DB2 | `mss_search_duration_seconds{kind}` |
| HP-DB1 | `mss_search_index_bytes`, E1 benchmark, existing ingest throughput series |

## 12. Implementation notes for the plan
- Order: add label values and the new series in `src/lib/metrics.ts` (check the label-allow-list test), emit from the compiler and search route, status-refresher queries, beacon enum update, alerts and Grafana row, then dashboards.
- carma-benchmark can read the new counters but does not depend on them; completeness checks keep using the article and translation tables.
- devops: nothing new to run; `ops/alerts.yml` and `ops/grafana/` gain rules and a row.

## 13. Decisions needed and open questions
- None blocking. Proposed targets in section 3 are for tuning after the first week of data.
- UNCONFIRMED: keeping the old beacon values for one release (cheap compatibility, can be dropped).
