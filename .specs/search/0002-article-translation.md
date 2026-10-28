---
spec: carma-searchability
number: 0002
title: Search over original and translated text
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0024-translation-no-confidence-article-page-only.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/search/0001-media-signal-service.md]
principles: [P3, P5, P7, P8]
supersedes: null
---

# 0002 Search over original and translated text

## 1. Summary and applicability
The user decided (ADR-0025) that search must work on both the original and the translated text, so a reader can look for original terms or English terms. The existing search compiles a boolean AST to SQL over `articles.search_text` (ILIKE, trigram GIN) and `articles.search_vector` (`simple` config, GIN) (`src/lib/search/compile.ts`, `db/migrations/0001_init.sql:42-44,176,182`). This spec adds the translation side without touching `articles`.

## 2. Search use cases
| Use | Who | Notes |
| --- | --- | --- |
| Ad hoc, original term (Arabic or Chinese brand name) | Analyst | Unchanged |
| Ad hoc, English term for a foreign article | Analyst | New: matches the translation |
| Standing queries | Out of scope in this PoC (search spec 0001) | Revisit: standing queries over translations would extend recall to foreign articles (P3) |

False-negative cost stays higher than false-positive cost, so the OR across both sides is the right default. Machine-translated matches can be wrong (a term in the translation that is not in the original), so they are labelled, not hidden.

## 3. Searchable document
Per article, two search documents:
| Side | Text | Source of truth | Fields |
| --- | --- | --- | --- |
| Original | `articles.search_text` / `search_vector` | `articles.headline`, `articles.body` | Unchanged |
| Translation | `article_translations.search_text` / `search_vector` | `headline_en`, `body_en` of the current row | New |

Headline and body are one text blob in `search_text` today (existing behaviour); the translation follows the same shape for consistency. Splitting headline from body for search is an existing limitation, not changed here.

## 4. Language analysis
- The translation is English, so the `simple` text-search config used today applies; no stemming (existing choice, ADR-0007: substring leaves for CJK and Arabic).
- Build `article_translations.search_text` with the same normaliser (`src/lib/normalise`) and record `search_text_ver`, so query-time normalisation matches index-time (the classic mismatch risk).
- Leaf classification (`classifyLeaf`) is per query term. Substring-kind leaves (Arabic, Chinese, Japanese terms) are searched on both sides with ILIKE (ADR-0027): a translation can keep proper names and brand names in their own script. FTS-kind leaves are searched on both sides.

## 5. Query design
In `compileAst`, wrap each term leaf as:
```sql
( <original predicate on a.*>
  OR EXISTS (SELECT 1 FROM article_translations t
              WHERE t.article_id = a.id AND t.article_version = a.version AND t.superseded_at IS NULL
                AND <same predicate on t.*>) )
```
- Negation (`and_not`): the right-hand side of NOT is compiled against the original side only (ADR-0027), so `A NOT x` excludes an article only if its original text matches `x`. Positive terms match either side.
- Phrases and prefix wildcards use `t.search_vector` the same way.
- Parameters are reused, not duplicated (one placeholder index, two uses), keeping the parameterised form.
- Planner risk: an OR with EXISTS may stop the GIN on `articles` being used as a bitmap. Alternative to benchmark: `a.id IN (SELECT article_id FROM article_translations WHERE ... )` UNION'ed with the original match, or two bitmap scans combined. Pick by plan inspection on realistic data (HP-S1; carma-dba verifies).
- Only the current translation (`superseded_at IS NULL`) and only the current article version are searched. A translation bound to an older version must not match (FP-S2).
- Ordering stays recency (ADR-0016); no relevance ranking, so no confidence figure is added (P7 consistent with ADR-0024).

## 6. Index strategy
`article_translations`: partial GIN on `search_vector WHERE superseded_at IS NULL` and a partial trigram GIN on `search_text` (ADR-0027). Write cost: one extra tsvector, GIN and trigram maintenance per translation insert, in the worker, not on the ingest hot path. The current `classifyLeaf` sends only non-Latin terms to the substring path, so the trigram index serves those; Latin partial-word search over translations is not added.

## 7. Bucketing
None. Search is a recency-ordered scan with keyset pagination today; translations ride on the same `published_at` through the join to `articles`.

## 8. Ranking and result presentation
Each result row gets `headline_en` (every foreign row with a translation, ADR-0026) and `matched_in`: `original`, `translation` or `both`. The UI shows a small "matched in translation" marker on the card, and the snippet, if any, comes from the side that matched (escaped as text, data-sanity spec section 7). Translation matches show the machine-translation label (P7).

## 9. Dedup
No change. Translation does not alter `content_hash`; duplicate detection stays on the original.

## 10. Freshness and coverage signalling (P3)
Translation arrives after the article is searchable (fresh before rich). So three states must be told apart on the search page:
- No match.
- Not translated yet: foreign articles with no current translation are searchable by original text only. Show a count: "N foreign-language articles in this period are not translated yet; English terms may miss them."
- Translation failed or deferred (dead, `too_long`, budget): same count, split by reason.
The count comes from articles with `language` not English LEFT JOIN current translations. It is computed per query scope, not globally.

## 11. Evaluation plan
- Known-answer tests: a term only in the original finds the article; a term only in the translation finds the same article; a term in both gives `both`; NOT excludes on either side.
- Planted foreign articles in Arabic, Chinese, French with a fixed (mock) translation, English query terms in each.
- Version test: resubmit with changed text; the old translation's terms no longer match, the new one's do after translation completes.
- Recall of the mock-translation path equals 100 percent; real-model recall is not measured (translation quality is out of scope, ADR-0024).

## 12. Risks and hot paths
| ID | Failure point | Effect | Detection |
| --- | --- | --- | --- |
| FP-S1 | Compiler ignores translations in one operator (phrase, wildcard, NOT) | Foreign article not found by English term | Tests per operator |
| FP-S2 | Superseded translation still matches | Match on text no longer shown | Version test, `superseded_at` filter |
| FP-S3 | Query-time normalisation differs from translation index-time normalisation | Visible term not found | `search_text_ver` equality check, shared normaliser test |
| FP-S4 | Plan regression: OR/EXISTS forces a sequential scan | Search latency exceeds the 2 s read timeout | EXPLAIN on seeded data, latency metric |
| HP-S1 | Search query with the OR across two relations | Interactive, every search | Inspect plan; compare OR-EXISTS versus UNION on 100k articles with 30 percent translated |

## 13. Handoff
- carma-dba: indexes in section 6, generated `search_vector` on translations, the plan experiment in HP-S1, grants for `app_read` (SELECT on `article_translations`).
- carma-data-sanity: indexed text is model output; validation precedes indexing (done in sanitization 0003 section 6).
- carma-telemetry: search latency split by whether translations were in the plan; count of not-translated foreign articles; share of matches by `matched_in`.
- carma-backend-testing: section 11.
- carma-ux: `matched_in` marker; not-translated coverage line; keep the pending state honest.

## 14. Decisions needed and open questions
- Decided by user: search both sides (ADR-0025).
- Decided by user (ADR-0027): NOT applies to the original side only.
- Open: should standing queries (future) also match translations? Default yes for recall, UNCONFIRMED.
- Open: backfilling translations for existing foreign articles so they become English-searchable; cost bounded by ADR-0010. UNCONFIRMED.
