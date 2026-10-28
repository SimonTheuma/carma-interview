---
spec: carma-searchability
number: 0003
title: Exact bare terms, wildcard terms with prefix and stem matching, summaries searchable
status: draft
date: 2026-10-28
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/architect/adrs/0034-english-stem-index-as-expression-index.md, .specs/architect/adrs/0035-stemming-scope-and-summaries-searchable.md, .specs/architect/adrs/0036-stemming-only-with-wildcard.md, .specs/architect/adrs/0032-english-first-display-with-original-underneath.md, .specs/search/0001-media-signal-service.md, .specs/search/0002-article-translation.md]
principles: [P3, P4, P5, P7]
supersedes: null
---

# 0003 Exact bare terms, wildcard terms with prefix and stem matching, summaries searchable

This spec was rewritten on 2026-10-28 after the user backtracked on default stemming and substring matching (ADR-0036). Nothing had been built, so the earlier version is replaced rather than superseded.

## 1. Summary and applicability
Ad hoc search only. The query language is the one in the requirements:
- `AND`, `OR`, `AND NOT`; nested brackets; phrases in double quotes; `*` wildcard; keywords are case-sensitive (lowercase `and` is a search term).
- **Bare term = exact whole word** (`simple` vector). **Phrase = exact phrase.**
- **`term*` = prefix OR English stem**, on original, translation and summary (ADR-0036).
- Search covers three documents per article: original, current translation, current summary (ADR-0035). The English-first display (ADR-0032) does not affect matching.

## 2. Search use cases
| Use | Who | Notes |
| --- | --- | --- |
| Precise brand or keyword search | Analyst | Default; bare words are exact |
| Broaden a term | Analyst | Add `*`: `startup*`, `renew*` |
| Phrase search | Analyst | Quotes |
| Standing queries, analytics | Out of scope | Unchanged |
False-negative cost is still higher than false-positive cost, but the requirement chooses opt-in breadth, so precision is the default. The empty-result help text points to `*` (UX 0004).

## 3. Searchable document
| Document | Text source | Exact (bare, phrase) | Wildcard (prefix OR stem) |
| --- | --- | --- | --- |
| Original | `articles.search_text` | `search_vector` (`simple`, existing) | prefix on `search_vector`; stem on `to_tsvector('english', search_text)` only for English/`und` labels |
| Translation | current `article_translations.search_text` | `search_vector` (`simple`, existing) | prefix on `search_vector`; stem on the English expression index |
| Summary | current `derived_values` row, `field = 'summary'` | `to_tsvector('simple', value)` (new index) | prefix on that; stem on `to_tsvector('english', value)` (new index) |
The English expression indexes are ADR-0034; the language predicate is ADR-0035. Query-time and index-time text must match: original and translation use the existing normaliser (`search_text_ver`); summaries are model output stored as plain text and are not normalised (case folding comes from the text-search config). Headline and body stay one blob.

## 4. Term policy
| Term | Behaviour |
| --- | --- |
| Bare Latin term | Exact whole word, case-folded, on `simple` vectors of all three documents. `startups` does not match "startup" |
| Quoted phrase or word | Phrase on `simple` vectors |
| `prefix*` (Latin) | Prefix on `simple` vectors OR English stem of the prefix on the English indexes. `renew*` finds renewable, renewables, renewed, renewing; `startups*` finds startup |
| `prefix*` on a stop word (`the*`) | Empty stem query; prefix only, never zero by accident |
| Arabic, Chinese, Japanese term | Substring (trigram) as today (ADR-0007), bare or with `*`; no stem |
| Mixed-script term | Any non-Latin character sends the term to substring, as today |
| `*` rules | At the end of one word; at least 2 characters before it; at most 5 wildcards, 20 terms (existing limits, `src/lib/search/parse.ts`) |
| Keywords | `AND`, `OR`, `AND NOT` upper case only; `and`, `or`, `not` are terms |
Foreign-language originals get no English stem (ADR-0035); a Latin-script foreign word is matched exactly or by prefix. Stemming is English; other languages' inflections are not handled (P5 cost, accepted).

## 5. Entities and quotes
Not in scope.

## 6. Index strategy
Four English-related expression indexes (DBA 0004, Amendment B): `articles_fts_en_idx` (partial on the `en`/`und` language predicate), `article_translations_fts_en_idx` (partial, current), `derived_values_summary_fts_en_idx`, and `derived_values_summary_fts_idx` (`simple`, for exact matching of summaries). Existing `search_vector` GIN indexes serve exact and prefix on original and translation; existing trigram indexes remain for Arabic/CJK only. No summary trigram index (the substring branch is gone for Latin text). Query planner risk: a `*` term has up to three predicates per document and three documents (HP-S1).

## 7. Bucketing and partitioning
No change; recency keyset ordering (ADR-0016).

## 8. Analytical layer
Not applicable.

## 9. Ranking and confidence presentation
No ranking, no confidence. Results carry `matched_in` as a set of sides (`original`, `translation`, `summary`); the UI marker is in UX 0004.

## 10. Deduplication
No change.

## 11. Freshness and coverage signalling
- Pending translation count line (spec 0002 section 10) stays.
- Summaries exist only after enrichment, so an unenriched article is not findable by summary words: coverage line "N articles in this selection have no summary yet" (UX 0004, wording UNCONFIRMED).
- No `trgm_index` notice for Latin terms any more (the flag still governs Arabic/CJK).
- The English indexes are built concurrently by the migration before the app serves traffic; until a build finishes only `*` queries are slower, not wrong.

## 12. Recall, precision and aggregate evaluation plan
Operator-by-side matrix (every cell a test): bare, quoted, phrase, wildcard, AND, OR, AND NOT, nested brackets, each across original, translation, summary.
Golden cases:
1. G1 `startups` finds a body with "startups" and does not find one with only "startup".
2. G2 `startup*` and `startups*` find both "startup" and "startups"; `renew*` finds renewable, renewables, renewed, but not "nonrenewable".
3. G3 `"media intelligence"` phrase unchanged; order and adjacency respected.
4. G4 lowercase keywords are terms: `cats and dogs` requires the word "and" (implicit AND of three terms); `cats OR dogs` is an operator; `cats AND NOT dogs` excludes.
5. G5 nested brackets `(a AND (b OR c))` return the same set as the expanded query.
6. G6 wildcard on translation and summary sides; summary-only terms find the article, `matched_in` includes `summary`.
7. G7 stem scope: an Arabic-labelled article with Latin "startups" in its original is not found by `startup*` through a stem (prefix still finds "startups"); an `und` or `en-GB` article is stemmed.
8. G8 `x AND NOT renew*` excludes by original text only (prefix OR stem); a summary or translation containing the term does not exclude.
9. G9 superseded translation and summary never match after a new article version.
10. G10 `the*` (stop word) returns prefix matches, not zero; `a*` (under 2 characters), `a*b`, a lone `*` and an unclosed quote give the existing parse errors.
11. G11 metacharacters `%`, `_`, `\`, `'` are literal; no SQL error.
12. G12 Arabic and Chinese terms unchanged against the pre-change baseline.
Precision cost of `*` is reported (extra hits versus the exact term for 20 ordinary words), not pass/fail.

## 13. Risks and hot paths
| ID | Failure point | Effect | Detection |
| --- | --- | --- | --- |
| FP-S5 | Wildcard misses a side or document | `renew*` misses a translation or summary match | Matrix, G6 |
| FP-S6 | Bare term broadened by accident (uses stem) | Predictable query language broken | G1 |
| FP-S7 | Stop-word wildcard compiles to an empty tsquery | Silent zero results | G10 |
| FP-S8 | Query terms concatenated into `to_tsquery` | Syntax errors | Placeholders only; `plainto_tsquery` for stems; sanitised prefix for `to_tsquery('simple', ...:*)` (existing sanitiser) |
| FP-S9 | Query expression or language predicate differs from the index | `*` queries scan | Plan tests (DBA E2, E6, E10) |
| FP-S10 | Over-matching by stem (news/new) | Dilution, only for `*` terms | Precision report |
| FP-S11 | Keyword case handling regresses | `and` treated as operator | G4 |
| HP-S1 | Wildcard query: prefix OR stem across three documents | Interactive, every wildcard search | EXPLAIN at 100k articles, 30 percent translated |
| HP-S2 | Write path: three more GINs (articles partial, translations partial, two on summaries) | Ingest and worker throughput | Ingest benchmark (DBA E1) |

## 14. Handoff
- **carma-dba:** DBA 0004 Amendment B: four indexes listed in section 6, no summary trigram index, sizing and write cost, plan experiments.
- **carma-telemetry:** latency by term kind (`exact`, `wildcard`, `nonlatin_sub`); share of queries using `*`; zero-result rate by kind.
- **carma-backend-testing:** section 12 matrix and goldens; keyword-case tests.
- **carma-ux:** wildcard hint instead of the loose-match note; echo shows `renew*`; marker for summary matches.

## 15. Decisions needed and open questions
- Decided: ADR-0036 (bare exact, `*` = prefix OR stem), summaries kept, ADR-0035 scope.
- Open: summary language assumed English (UNCONFIRMED).
- Open: whether `*` should also match inside words (`*able`); no, per ADR-0005, suffix wildcard only.
