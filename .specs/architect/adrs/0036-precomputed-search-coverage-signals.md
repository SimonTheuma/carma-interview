---
adr: 0036
title: Precompute corpus-wide search coverage signals on the metrics-refresh interval
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: null
---

# ADR-0036: Precomputed corpus coverage signals for search

## Context and problem statement
Each `/api/search` request was issuing whole-table counts (`count(*)` on `articles`, distinct enriched sentiment/topic counts, watermarks) for the coverage line. Those figures do not depend on the user's filters. At corpus scale they dominate request cost (review 0005). Live accuracy to the millisecond is not required for a coverage note.

## Considered options
1. Keep live corpus counts on every search request.
2. Cache corpus totals, enrichment counts and watermarks in `system_flags`, refreshed by the existing `metrics-refresh` worker (~60s), and read them in one statement per search (chosen).
3. Introduce a separate cache store (Redis). Rejected: PostgreSQL-only constraint.

## Decision outcome
Chosen option 2.
- The worker upserts: `coverage_corpus_articles`, `coverage_enriched_sentiment`, `coverage_enriched_topics`, `coverage_watermark_published_at`, `coverage_watermark_ingested_at`.
- Search reads those keys together with `trgm_index` in one statement.
- Filter-dependent figures (base count, in-scope selection, translation coverage, summary-missing, `excluded_by_filter_not_enriched`) stay live in a single filtered-coverage statement.
- Coverage freshness is the refresh interval (up to ~60s lag after enrichment).
- If the corpus or filtered-coverage read fails, search still returns the list and marks coverage unavailable (P3: results over signals).

### Consequences
- Good: search statement budget drops corpus-wide scans; cost no longer grows with every request against the full table.
- Bad: coverage line can lag enrichment by one refresh interval; first requests after a cold start may see empty flags until the worker runs once.
- Risks: stale flags if the worker is down — surface as unavailable rather than inventing zeros that look complete.
