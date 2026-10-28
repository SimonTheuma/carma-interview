# English-first search — phase 1 notes (Amendment B / ADR-0036)

Date: 2026-10-28  
Feature: english-first-substring-search

## Environment
- PostgreSQL 16.6 (disposable Docker on `127.0.0.1:54398`)
- Migration: `0007_english_search_indexes.sql` (four concurrent expression indexes; Amendment B)
- Host: win32, Node v22.14.0

## Indexes (Amendment B)
| Index | Role |
| --- | --- |
| `articles_fts_en_idx` | English stem half of `*` on originals with primary lang `en`/`und` |
| `article_translations_fts_en_idx` | English stem half of `*` on current translations |
| `derived_values_summary_fts_en_idx` | English stem half of `*` on current summaries |
| `derived_values_summary_fts_idx` | Exact / phrase / prefix on current summaries (`simple`) |

Dropped versus pre–ADR-0036: `derived_values_summary_trgm_idx` (no Latin substring branch).

## Q1 summary language
Default: English (assumed). Spot-check of planted mock summaries in seed helper uses English text only.

## Plan shape (T1.6, Amendment B)
OR/`EXISTS` compiler shape retained. Plan tests P1–P7 pass on a 2k seed: English indexes appear only for `*` queries; bare terms use `simple` FTS only.

Human EXPLAIN read on 500-row seed (`EXPLAIN` list query, LIMIT 20), 2026-10-28:

| Query | Planner shape (summary) |
| --- | --- |
| `startups` (bare exact) | `Index Scan` on `articles_keyset_idx` + Filter `search_vector @@ plainto_tsquery('simple', …)`; **no** `articles_fts_en_idx` |
| `startup*` (prefix OR stem) | Keyset Index Scan + Filter `(to_tsquery('simple', 'startup:*') OR (lang en/und AND english tsvector @@ plainto_tsquery))` |
| `oil AND NOT renew*` | Same keyset path; NOT original-side only (prefix OR stem) |
| `the*` (stop-word wildcard) | Prefix only on simple vector (stem half omitted) |

At this scale the planner prefers the keyset index and evaluates FTS in the filter. No Seq Scan on `articles` for the outer path. Retained OR/`EXISTS` shape (HP-1).

## B1 ingest (T1.7)
Prior measurement (2026-10-24, pre–Amendment B indexes including summary trigram) still informative for write cost of the three English GINs:

| Variant | Achieved articles/s | vs without-0007 |
| --- | --- | --- |
| Through 0006 only | 788.43 | baseline |
| Through 0007 | 791.29 | +0.4% |

Gate (proposed ≤15% regression): **pass**. Amendment B replaces summary trigram with a small `simple` summary GIN; expected write cost ≤ prior.

## B2 search latency
On 2k seed (prior notes): list ~30 ms, wall ~46 ms with parallel post-list statements. Amendment B bare/`exact` path should match or beat the old `stem_sub` path (no ILIKE, no english expression on bare terms). Wildcard is the slow case under the 2 s read timeout.

## Extra-hit / stem collisions (FP-S10)
Stem collisions (`news`/`new`) apply only to `*` terms now. Users keep bare exactness by default; broaden with `*`.

## Verification (2026-10-28)
- Unit: `tests/unit/search-compile-translation.test.ts`, `parse.test.ts` keyword-case — pass (120 unit tests)
- Integration G1–G12 Amendment B — pass
- Integration search-plans P1–P7 Amendment B — pass
- Migration 0007 (simple summary FTS, not trigram) — pass
