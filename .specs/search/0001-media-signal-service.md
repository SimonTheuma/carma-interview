---
spec: carma-searchability
number: 0001
title: Boolean search, filters and the weekly/monthly aggregate for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/architect/adrs/0002-nextjs-postgres-stack.md
  - .specs/architect/adrs/0003-enrichment-providers.md
  - .specs/architect/adrs/0004-confidence-in-scope.md
  - .specs/architect/adrs/0005-search-grammar-defaults.md
principles: [P1, P3, P5, P6, P7, P8, P10]
supersedes: null
---

# Search and analytical layer

## 1. Summary and applicability

Applies fully: the assignment's largest graded section is boolean search, and its dashboard needs an aggregate over the same filters.

Design in one paragraph: a hand-written scanner and recursive-descent parser turn the query into an AST. A compiler turns the AST into one SQL boolean expression whose leaves are bound parameters: **FTS leaves** (`simple` configuration, `plainto_tsquery` / `phraseto_tsquery` / a sanitised `:*` prefix) for space-delimited scripts, and **substring leaves** (`ILIKE` on a normalised text column, trigram-indexed) for Chinese and, by default, Arabic. Results are ordered by recency with keyset pagination; there is no relevance ranking in this build. The list and the aggregate use one shared filter builder, so a chart bar and the list behind it cannot disagree.

Scope reminders (ADR-0001): 20 articles now; 800/s and standing queries are a growth path. Standing queries and entity/quote records are **not built** (section 5 says why).

## 2. Search use cases

| Kind | User | Volume | Latency | False negative vs false positive |
| --- | --- | --- | --- | --- |
| Ad hoc boolean search | Analyst on the search page | Handful of queries | Under 1 s on 20 rows; target under 2 s at 1 M rows (growth check) | A missed article is worse (P3). Substring leaves widen recall on purpose |
| Standing queries | Not in scope | none | none | Growth path: the same AST compiles to a matcher run at ingestion. The AST being a pure data structure is what keeps this open |
| Analytical | Same analyst, dashboard | A few per page view | Under 1 s | A plausible but wrong count is the risk; guarded by shared filters, conservation and drill-through (section 8) |

**Analytical questions in scope** (each becomes a test):

- AQ1: How many articles per week (or month) for a filter set?
- AQ2: The same, split by sentiment, by language or by topic.
- AQ3: Click a bar and see exactly those articles.

## 3. Searchable document

| Field | Role |
| --- | --- |
| `headline`, `body` | Text, searched together as one unweighted `search_vector` (recency-only ordering, ADR-0016; earlier weight wording superseded). Kept as reduced text, system of record |
| `search_text` | Derived: `headline + ' ' + body` after the shared normaliser (below). Rebuildable from the stored text (P8) |
| `search_vector` | Derived: generated `tsvector` from `search_text` with the `simple` configuration |
| `source`, `language`, `published_at` | Filters (not text-searched) |
| `sentiment` (+ confidence), `topics` (+ confidence) | Derived filters from enrichment, with confidence and origin carried (ADR-0004). Absent until enriched |
| `summary` | Displayed only. Not searched in this build (it is derived; searching it would double count the same words) |

Headline and body are not separate vectors because no assignment question needs headline-only matching; the weights preserve the option. If a headline-only question appears, add a second vector.

**Shared normaliser** (one module used at index time and at query time, so they cannot drift):
Unicode NFKC, case folding, strip Arabic diacritics (harakat) and tatweel, unify alef variants (أ إ آ to ا), ya/alef-maqsura (ى to ي) and taa marbuta (ة to ه), full-width to half-width. It does **not** strip the Arabic definite article `ال` or prefixes (see section 4).

## 4. Language analysis plan (P5)

Text-search configuration is `simple` for every language: no stemming, no stop words. Reasons: `AI` is not dropped; a phrase means what was typed; `renew*` is a true prefix; nothing is routed by the (unverified) `language` field. Cost: `renewable` does not match `renewables`. That is the behaviour the brief describes (the wildcard exists for this).

| Script | Leaf | Why |
| --- | --- | --- |
| Latin, Cyrillic, other space-delimited | FTS | Exact token match, GIN index |
| Chinese (Han) and Japanese kana | Substring on `search_text` | No spaces between words, so tokenisation finds nothing. Substring matching is a recall-first baseline: it can match inside a longer word (precision cost), it never misses (P3) |
| Arabic | Substring on `search_text` (default, decision S1) | Prefixes attach to words |
| Mixed-script query term | Leaf chosen per term by its script | A query can mix English and Chinese terms |

**Evidence from the sample (token-level check against id 8):** the headline contains `العقارات` ("the real estate"). A query for `عقارات` finds **no** token match, because the token carries the attached article `ال`. A substring leaf matches (the query is contained in the token). This is why S1 recommends substring for Arabic. Light stemming (stripping `ال`, `و`, `ب`, `ل`, `ف`, `ك`) is the precision-oriented alternative; it needs a stemmer or dictionary and still misses variants.

**Fallback for any other language:** NFKC + case folding + FTS `simple`; scripts that have no spaces (Thai, Khmer and similar) are routed to the substring leaf by script, not by language label. Language mismatch (the stored `language` disagreeing with detected script) is not used for routing, so a mismatch cannot hide an article; log it as a flag only.

**Chinese notes:** a two-character Chinese term gives no usable trigrams in `pg_trgm`, so the planner may scan. Correctness holds; only speed suffers (HP-S2). `pg_trgm` also depends on how the database locale classifies non-ASCII characters; verify trigram extraction on the actual image before relying on the index (`UNCONFIRMED`). Growth path: `pg_bigm` or PGroonga (2-gram index), or a segmenter, each to be decided with carma-dba if the extension is permitted.

## 5. Entities and quotes

Not built. The assignment has no entity or quote requirement, and the enrichment output is summary, sentiment and topics only. Nothing here prevents adding them: the article id is a stable key for child tables. Documented as growth path in the README. Topic is the only tag grain.

## 6. Index strategy

| Option | Recommendation |
| --- | --- |
| GIN on `search_vector` (FTS leaves) | Yes. Generated stored column, so the article is searchable the instant it is inserted (P1) |
| GIN `gin_trgm_ops` on `search_text` (substring leaves) | Yes, if `pg_trgm` is permitted (D3). If not, substring leaves run unindexed and the README says so |
| B-tree `(published_at DESC, id DESC)` | Yes. Keyset order and date range |
| B-tree `(source, published_at DESC, id DESC)` and `(language, published_at DESC, id DESC)` | Yes, for filter + keyset. Note: all 20 sources in the sample are distinct, so a source index is not selective on this data; it is kept because real feeds repeat sources |
| Fuzzy / misspellings | Not built. Trigram similarity would serve; out of scope |
| External engine | Not allowed or needed |

Environment checks still to do: PostgreSQL major version and whether `pg_trgm` and `unaccent` are available in the image (`UNCONFIRMED`). carma-dba owns the exact DDL.

## 7. Bucketing and partitioning

None now. Table is unpartitioned (ADR-0001). Growth path: monthly range partitions on `published_at`; GIN indexes per partition; the newest partition may carry lighter indexes. Standing-query grouping (term to query map) is a growth item.

## 8. Analytical layer

**Grain.** Article only (one row per article). Children: topics (multi-label) and enrichment parts, owned by carma-dba.

**The query language (specified so the parser can be written and tested).**

Tokens: `(` `)` `"` `*`, whitespace, and words. The only operators are the exact, case-sensitive words `AND` and `OR`, and the exact sequence `AND NOT`. Everything else is a term (including lowercase `and`, `or`, `not`, and a capital `NOT` that does not follow `AND`: see errors).

```
query    := or
or       := and ( "OR" and )*
and      := unary ( ( "AND" | "AND" "NOT" | <implicit> ) unary )*   // AND NOT = and-not; implicit = adjacency
unary    := "(" or ")" | phrase | wildcard | term
phrase   := '"' words '"'
wildcard := word "*"                    // suffix only
```

Precedence: `AND` / `AND NOT` / implicit-and bind tighter than `OR` (ADR-0005). Evaluation is left to right inside a group.

Compile (one bound parameter per leaf; no query text is ever concatenated into SQL):

| AST | SQL |
| --- | --- |
| term (FTS) | `search_vector @@ plainto_tsquery('simple', $n)` |
| phrase (FTS) | `search_vector @@ phraseto_tsquery('simple', $n)` |
| wildcard (FTS) | `search_vector @@ to_tsquery('simple', $n)` where `$n` = lexeme + `:*`, built only from `[\p{L}\p{N}]+` checked by the parser, so tsquery syntax cannot be injected |
| term / phrase / wildcard (substring) | `search_text ILIKE $n ESCAPE '\'` where `$n` = `%` + term with `\ % _` escaped + `%` |
| A AND B | `(A) AND (B)` |
| A OR B | `(A) OR (B)` |
| A AND NOT B | `(A) AND NOT (B)` |

`search_vector` and `search_text` are `NOT NULL` (empty string, never null), so `NOT` cannot hit three-valued logic (FP-S3).

**Parse errors** (never a 500; HTTP 400 with `{code, message, position}`; the UI shows the message and marks the position):

| Case | Message |
| --- | --- |
| Empty or whitespace query | "Enter a search query" (or: no filter applied; decision for UI: empty query = list view) |
| Unbalanced bracket | "Missing closing bracket" / "Unexpected closing bracket" at position |
| Unterminated quote | "Missing closing quote" |
| Empty phrase `""` or empty group `()` | "Empty phrase / group" |
| Dangling operator `a AND`, `OR a` | "AND needs a term on both sides" |
| Leading `NOT`, or `NOT` not after `AND` | "Use AND NOT to exclude a term" |
| Wildcard not a suffix (`*abc`, `a*b`, `*`) or on a phrase | "Wildcards go at the end of a single word" |
| Wildcard prefix shorter than 2 characters (non-CJK) | "Wildcard needs at least 2 letters" |
| Caps exceeded | "Query too long / too deep / too many terms" |

**Caps** (`UNCONFIRMED` numbers, configurable): 500 characters, nesting depth 8, 20 leaves, 5 wildcard leaves, statement timeout 2 s on search queries. The scanner is a hand-written character loop, not a regex, so crafted input cannot cause catastrophic backtracking (HP-1).

**Echo.** Every response includes `parsed`: the query printed back with all operators explicit and all brackets shown, e.g. `a b OR c` returns `((a AND b) OR c)`. This makes implicit-AND and precedence visible (mitigates the typo risk in ADR-0005).

**Filters.** Search composes with: date range (half-open `[from, to)`, UTC), source (list), language (list), sentiment (list), topic (list). One function builds the `WHERE` clause and parameters; both the list endpoint and the aggregate endpoint call it. Sentiment and topic filters need enrichment: articles not yet enriched are excluded by those filters, and the response always carries `coverage` (below), so the exclusion is visible rather than silent (P3).

**Keyset list.** `ORDER BY published_at DESC, id DESC`; cursor = opaque, signed or at least validated (published_at, id); `WHERE (published_at, id) < ($cursor_ts, $cursor_id)`; fetch `limit + 1`. A cursor from a different filter set is detected (cursor embeds a hash of the filter set) and rejected with 400 rather than returning a confusing page.

**Aggregate.** Parameters: the same filters, `bucket` in `{week, month}` (whitelisted enum, default `week`), `group_by` in `{none, sentiment, language, topic}`, never `source` (see below). Query shape: `date_trunc(bucket, published_at AT TIME ZONE 'UTC')`, joined to `generate_series` so empty buckets are returned as zero. Week starts Monday (PostgreSQL `date_trunc('week')`, ISO weeks). All boundaries are UTC; the response states `timezone: "UTC"` and each bucket gives `start` and `end` (half-open).

Sample-data check (computed from `sample_articles.json`): weekly buckets are ISO 2026-W24 to W29 with counts **1, 3, 3, 6, 6, 1** (total 20); monthly are **2026-06: 8** and **2026-07: 12**. With the default `week` the chart has six bars; `month` has two, which is why the UI defaults to weekly.

Honest-number rules built in:

- `total` and `sum(buckets)` must be equal for `group_by=none` and `group_by=sentiment`/`language`. A test asserts this (conservation).
- **Unenriched articles are never dropped from a breakdown.** `group_by=sentiment` includes a series `not_enriched`, so totals still conserve (P3).
- `group_by=topic` is multi-label: an article appears in every topic it has, so series can sum to more than the total. The response sets `multi_label: true` and the UI must say so (decision S4).
- `source` is excluded from `group_by`: every one of the 20 sample articles has a distinct source, so it would draw 20 series of 1. Source is still a filter.
- `coverage` object on list and aggregate: `articles_matching_base_filters` (count after date, source and language filters, before text and derived filters; the UI uses it to tell "not covered" from "no match", UX gap G1), `articles_in_scope`, `enriched_sentiment`, `enriched_topics`, `excluded_by_filter_not_enriched` (when a derived filter is applied), `watermark` (latest `published_at` and latest `ingested_at` searchable).
- Rates and shares: none are produced. If the UI shows a share, the denominator is `articles_in_scope` and n is shown beside it.
- **Facets:** `GET /api/facets` returns distinct sources, languages, topics and sentiments with counts for the unfiltered corpus (cached; UX gap G2).
- **Drill-through:** a bar (bucket start/end, optional series value) maps to a list request with `from=start`, `to=end`, the same other filters and the same query. The list `total` must equal the bar's count (test AQ3). Computing the list `total` for a bar requires a count query; the list endpoint exposes `total` only when requested (`include_total=true`), because counting can be costly at scale.

**Serving.** On demand from the base table. Rollups and materialised views are growth path (day-grain rollup by language/sentiment/topic, rebuildable from articles); not needed at this scale.

## 9. Ranking and confidence presentation

No relevance ranking: results are ordered by recency, newest first (decision S3). Reasons: the brief requires keyset pagination, and a relevance-ordered keyset needs a rank-and-id cursor and a stable rank; the grading does not ask for ranking. Growth path: `ts_rank_cd` with weights (headline over body), cursor `(rank, id)`, and the rank shown as an uncalibrated "database text-rank score" on the 0 to 100% scale with origin and range (P6, P7).

No server-side snippets: `ts_headline` returns markup, which would add an XSS surface (FP-S9). If highlighting is wanted, the client splits the already-escaped text on the matched terms.

Derived-field confidence (sentiment, topics) is shown per ADR-0004 and filterable later by threshold; that is a UI choice (carma-ux).

## 10. Deduplication

Exact duplicates are caught at ingestion by content hash (carma-dba, carma-data-sanity); a duplicate is recorded, not silently dropped. Each stored article counts once in every aggregate. Near-duplicate clustering is out of scope (growth path). No sample article duplicates another.

## 11. Freshness and coverage signalling

Each search/list/aggregate response carries `coverage` and `watermark` (section 8). The UI distinguishes four empty states:

1. **No match**: the query is valid and nothing matches.
2. **Not covered**: the filter range or language/source has no articles at all (the corpus is empty for that filter).
3. **Not yet enriched**: sentiment/topic filters excluded N articles that are still waiting for enrichment (shown as a count).
4. **Enrichment paused/failed** for some articles (job state surfaced; budget or provider breaker).

## 12. Recall, precision and aggregate evaluation plan

**Golden queries, with expected ids from a token-level oracle run against the 20 sample articles on 2026-10-24.** The oracle is an independent re-implementation (lowercase, split on non-letters, exact tokens, adjacent-token phrases, token-prefix wildcards). The Postgres `simple` parser tokenises some strings differently (numbers like `87.40`, hyphens, URLs), so every expected set below must be re-confirmed against the real implementation once; a difference is a bug in one of the two and needs explaining, not silencing.

| # | Query | Expected ids | Note |
| --- | --- | --- | --- |
| G1 | `"oil prices" AND (geopolitical OR "supply chain")` | 1 | `"oil prices"` alone: 1. `"supply chain"` alone: 7. `geopolitical`: 1, 4 |
| G2 | `renewable AND NOT (nuclear OR coal)` | 5 | `renewable`: 5; nuclear and coal match nothing in the sample, so this does not prove NOT works |
| G3 | `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` | **none** | `AI`: 2, 3, 10. `AI AND ("healthcare" OR "diagnostic")`: 10. `startup*`: 10. The assignment's own example returns zero rows on the sample, which is correct. Use it as an empty-result test, and prove NOT with G3a below |
| G3a | `AI AND ("healthcare" OR "diagnostic")` | 10 | Positive control for G3 |
| G4 | `renew*` | 5 | Wildcard |
| G5 | `AI` and `ai` | 2, 3, 10 (same) | Terms are case-insensitive; only operators are case-sensitive |
| G6 | `and` (lowercase) | 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20 | Lowercase operator is a plain term |
| G7 | `AND` alone | parse error | Dangling operator |
| G8 | `عقارات` | 8 | Substring leaf over `العقارات`; an FTS-only leaf would return nothing |
| G9 | `科技` and `海外` | 9, 9 | Chinese substring leaf |
| G10 | `a OR b AND c` | parse echo `(a OR (b AND c))` | Precedence |
| G11 | `(oil` | parse error, position 1 | Unbalanced |
| G12 | `renewable AND NOT nuclear` | 5 | Plus a synthetic fixture where NOT removes a row (see below) |

To prove `AND NOT` removes rows, the test suite includes one extra synthetic fixture pair (test data, not part of `sample_articles.json`): two articles that differ only by one word. `UNCONFIRMED`: needs the user's OK to add synthetic fixtures (also needed for prompt-injection tests).

**Aggregate tests.** Known-answer: weekly counts 1, 3, 3, 6, 6, 1 and monthly 8, 12 on the unfiltered sample; with `language=ar` one bucket of 1; conservation (`sum(buckets) = total`) for each `group_by` except `topic`; empty buckets returned as zero; drill-through count equals the bar for every bar; UTC boundary test with an article at `23:59:59Z` and `00:00:00Z` either side of a Monday.

**Keyset tests.** Walking all pages returns every id exactly once, including with equal `published_at` values (synthetic ties); changing the filter between pages is rejected.

**Recall regression.** Because the sample is tiny, add a generated corpus (seeded) with planted mentions in English, Arabic (with `ال`, `و`, `ب` prefixes) and Chinese (inside longer sentences) and unplanted look-alikes. Recall target for planted mentions: 100% (a miss is a bug); precision is measured and reported, not targeted. `UNCONFIRMED`: build only if time allows (cut line).

## 13. Risks and hot paths

| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-S1 | Arabic prefix `ال` blocks exact-token match | Mention missed | P3, P5 | G8; confirmed on id 8 |
| FP-S2 | `pg_trgm` extraction on CJK/short strings depends on locale | Substring leaf correct but unindexed; slow at scale | P1 | `EXPLAIN` on the substring leaf; `HP-S2` timing |
| FP-S3 | `NOT` over a nullable column | Rows silently excluded | P3 | Columns are `NOT NULL`; test with an empty-headline article (id 17) |
| FP-S4 | Implicit `AND` hides a typo | Wrong results look plausible | P3 | Parsed echo shown in the UI |
| FP-S5 | Derived filter excludes unenriched articles silently | Count looks complete but is not | P3 | `coverage.excluded_by_filter_not_enriched` shown |
| FP-S6 | List and aggregate use different filter code | Bar count differs from list | P3, P8 | One shared builder; drill-through test |
| FP-S7 | Topic breakdown double-counts | Series sum exceeds total | P10 | `multi_label: true` and UI note |
| FP-S8 | Week/month boundary in the wrong time zone | Article in wrong bucket | P3 | UTC boundary test |
| FP-S9 | Server-side snippets return markup | XSS | P2 | No `ts_headline`; test that API responses contain no markup from highlighting |
| FP-S10 | Normaliser differs at index and at query | Visible text not found | P3, P5 | One shared module; round-trip test in three scripts |
| FP-S11 | Postgres default parser tokenises numbers, URLs, hyphens unexpectedly | Oracle mismatch | P3 | Compare oracle with Postgres on all golden queries |
| FP-S12 | Wildcard with a short or empty prefix | Full scan / huge result | P1 | Minimum prefix 2, cap on wildcard leaves |
| FP-S13 | Cursor reused across filters | Skipped or repeated rows | P3 | Cursor carries filter hash |

| ID | Path | Why hot | What needs a human | Measurement |
| --- | --- | --- | --- | --- |
| HP-S1 | Query scanner/parser/compiler | Security-sensitive, per query | Read line by line: character classes, escaping of `\ % _`, the lexeme check for `:*`, caps | Fuzz with random strings: never throws unhandled, never emits text into SQL |
| HP-S2 | Search `WHERE` with OR of FTS and substring leaves | Planner must BitmapOr two indexes | Check `EXPLAIN` for G1, G3 and a mixed English+Chinese query | p95 on 1 M synthetic rows |
| HP-S3 | Aggregate with `group_by=topic` | Join to a child table | Plan with and without filters | Time at 1 M rows |

## 14. Handoff

- **carma-dba:** columns `search_text` (NOT NULL), `search_vector` (generated, GIN), GIN trigram on `search_text` (if D3 allows), keyset and filter B-trees (section 6), `ingested_at`, topic child table with a covering index for `topic` filters and `group_by=topic`, immutable wrappers if `unaccent` is used inside a generated column. Verify `pg_trgm` behaviour on non-ASCII text on the chosen image. Aggregate runs on demand; rollup is growth path.
- **carma-data-sanity:** the scanner must be a character loop (no regex backtracking); lexeme sanitisation for `:*`; ILIKE escaping; query caps and statement timeout; no server-side markup in responses; sentiment/topic filter values are whitelisted enums.
- **carma-telemetry:** search latency by phase (parse, compile, execute), parse error count by code, rejected-by-cap count, leaf-type counts (FTS vs substring), `coverage` values, list and aggregate latency.
- **carma-backend-testing:** golden queries G1 to G12, aggregate tests, keyset tests, fuzz of the parser, oracle-versus-Postgres comparison, ids 6, 8, 9, 17, 18 as fixtures.
- **carma-ux:** query box with the parsed echo and error position, four empty states, `coverage` line, multi-label note, week default, bar click to drill-through, sentiment series including `not_enriched`.

## 15. Decisions needed and open questions

| ID | Decision | Options (recommended first) |
| --- | --- | --- |
| S1 | Arabic leaf | (a) Substring on normalised text: recall-first, matches inside longer words. (b) FTS exact + light prefix stripping: more precise, needs a stripper and still misses variants. Evidence: `عقارات` misses `العقارات` under exact FTS |
| S3 | Ranking | (a) Recency only (matches keyset requirement). (b) Relevance with a rank cursor (more work, not graded) |
| S4 | Topic breakdown semantics | (a) Multi-label: an article counts under each of its topics (series may sum above total, labelled). (b) Primary topic only: sums to total but hides secondary topics |
| S5 | Synthetic fixtures | (a) Add a small synthetic test set (NOT-removal pair, tied timestamps, prompt-injection samples, planted multilingual mentions). (b) Use only the 20 sample articles (cannot prove NOT or ties, no injection test) |

Held defaults (not asked): query caps (section 8), minimum wildcard prefix 2, empty query means "no text filter" (list view), `group_by` excludes source, `include_total` opt-in.

Open questions: is `pg_trgm` available (D3)? Does the real Postgres tokenisation match the oracle (section 12)? Does the UI need a "clear parse error" format beyond message and position?

**Resolved 2026-10-24:** S1 substring (ADR-0007), D3 core + contrib (ADR-0006), S4 multi-label (ADR-0008), S5 synthetic fixtures approved. S3 (recency only, no relevance ranking) is held as a default for the pre-plan round.
