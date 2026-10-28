---
spec: carma-architect
number: 0004
title: English-first display and substring search by default
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0005-search-grammar-defaults.md, .specs/architect/adrs/0007-substring-leaves-for-cjk-and-arabic.md, .specs/architect/adrs/0016-recency-ordering-no-relevance-ranking.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/architect/adrs/0026-english-headline-on-all-foreign-cards.md, .specs/architect/adrs/0027-search-not-original-only-and-trigram-on-translations.md, .specs/search/0002-article-translation.md]
principles: [P3, P5, P7, P8, P10]
supersedes: null
---

# 0004 English-first display and substring search by default

## 1. Summary
Two changes to shipped behaviour, no new tables and no new services.

1. **English first.** Headlines and titles show English as the primary line, with the original underneath. On the article page the full text shows the English translation first, with a control that reveals the original underneath it (stacked, not swapped). English-original articles are unchanged.
2. **Substring search by default.** Unquoted Latin terms stop being whole-token FTS and become substring matches over both original and translated text. A term in double quotes is the exact (whole-word, or phrase) match, and the parsed-query echo shows it in quotes.

One finding changes the design: **a literal substring match does not solve the user's own example.** `ILIKE '%startups%'` finds "startups-focused" but not "startup", because "startup" does not contain "startups". Getting "startups" to find "startup" needs the query term trimmed to a stem before matching. This is the main decision (D1).

The existing indexes already cover the work: `articles_trgm_idx` (`db/migrations/0001_init.sql:182`) and the partial trigram index on current translations (`db/migrations/0004_article_translations.sql:102`). No migration is expected.

## 2. Requirements digest
Functional:
- F1. Card and article-page headline: English primary, original underneath, for non-English articles.
- F2. Article page body: translated English first, original available on request underneath it.
- F3. Search: substring matching is the default for terms.
- F4. Exact matches are written and echoed inside double quotes.

Non-functional: recency ordering stays (ADR-0016), both sides searched (ADR-0025), NOT stays original-only (ADR-0027), no extra per-query LLM or network cost, search stays inside the 2 s read timeout.

Principles: P3 (a missed mention is the costliest failure, so recall wins over precision), P5 (term classification stays per term, not per stored language), P7 (the echo must tell the user what was actually matched), P8 (the original stays one click away).

## 3. Codebase findings
| Area | Finding | Evidence |
| --- | --- | --- |
| Leaf classifier | Only Arabic/CJK terms go to the ILIKE path; every Latin term goes to FTS `simple` (no stemming) | `src/lib/search/leaf.ts:6-16` |
| Compiler | `compileTerm` already supports ILIKE on `a.search_text` and `t.search_text` with escaped `%term%`; phrase uses `phraseto_tsquery`; wildcard uses `to_tsquery(... :*)` | `src/lib/search/compile.ts:45-80` |
| Parser | `"..."` already becomes `{type:"term", phrase:true}`; `*` suffix is a wildcard | `src/lib/search/parse.ts:32-175` |
| Echo | Phrases already echo as `"value"`; other terms echo bare | `src/lib/search/echo.ts:8-13` |
| Indexes | Trigram GIN on `articles.search_text` and on current `article_translations.search_text` | `0001_init.sql:182`, `0004_article_translations.sql:102-106` |
| Trigram caveat | The trigram index is optional (`system_flags.trgm_index`); with it off, ILIKE falls back to scans | `0001_init.sql:179-187` |
| Cards | `h2` shows the original; "English: ..." muted line below when a translation exists (ADR-0026) | `src/components/ArticleCard.tsx:84-96` |
| Card data | Search returns `headline_en` and `left(a.body, 600)` as `body_excerpt`; no English excerpt | `src/lib/search/run.ts:111-113,182-186` |
| Article page | Defaults to translation, but a toggle **swaps** translated and original; `<title>` already prefers English | `src/components/TranslatedText.tsx:50-68`, `src/app/articles/[id]/page.tsx:40` |
| Not translated yet | Older foreign articles have no translation (ADR-0028), so English-first falls back to original with a note | `src/lib/translate/display.ts:48-52` |

Unknown: real corpus share of Latin non-English text, and whether `pg_trgm` is on in the target database (UNCONFIRMED; `trgm_index` flag exists for exactly this).

## 4. Proposed architecture
### 4.1 Display (no data-model change)
```
card (foreign, translated):     h2  headline_en            lang=en
                                p   original headline      lang=<src>, muted, "Original (<language>)"
card (foreign, not translated): h2  original headline      + "English translation pending" note
card (English):                 h2  headline              (unchanged)
article page body:              translated text first
                                [Show original text] reveals the original BELOW it, translated stays visible
```
- The pure display choice moves into one small function (headline pair selection) so cards, article page and `<title>` share it and it can be unit-tested.
- The article-page control changes from swap to reveal-below. The existing telemetry beacon (`/api/telemetry/translation-view`) keeps the same event with value `original_shown`.
- The card body excerpt is the open scope question (D3).

### 4.2 Search
Term compilation, per unquoted Latin term of 3 or more characters:
```
orig:  a.search_text ILIKE %term%   [OR ILIKE %stem% if D1 = stem]
trans: EXISTS(... t.search_text ILIKE %term% ...)   same shape
```
- Quoted term → exact: existing `phraseto_tsquery('simple', ...)` on `search_vector` (whole words, phrase order). No code change except being the documented exact syntax.
- Terms under 3 characters stay on FTS exact, since a trigram index cannot serve them and a scan would break HP-1.
- Arabic/CJK terms: unchanged (already substring, ADR-0007).
- `*` wildcard stays valid and becomes mostly redundant; keep for compatibility.
- NOT keeps ADR-0027: the negated term is compiled original-side only, now as substring. A negated substring excludes more articles (precision-up for the exclusion, recall-down for the result). Echo must say so.
- Ordering stays `published_at DESC` (ADR-0016).

Echo (P7): unquoted terms render as `startups~` or in a "contains" form (final notation is a UX decision), quoted terms render as `"startups"`, so the user sees which terms are exact and which are substring.

## 5. Options considered
### 5.1 What "substring" means for a Latin term (D1)
| Option | Behaviour for query `startups` | Cost | Principles |
| --- | --- | --- | --- |
| A. Literal substring `%startups%` | Misses "startup" (the user's example). Finds "startups", "startups-focused". | Smallest change. | Fails the stated example. |
| B. Substring plus light suffix trimming (recommended) | Also matches `%startup%` (trailing `s`, `es`, `ies`→`y`, `ing`, `ed`, minimum stem 4 characters). Finds "startup", "startups". | Small pure function, English-biased, harmless on other Latin text. Imprecise: "startup" also matches "startups", "startup-grade". | P3 served; P5 partly (English suffix rules only, other languages get substring only). |
| C. English stemming FTS (`to_tsvector('english')`) | Finds startup/startups by stem, not by substring. | New generated column and GIN on both tables, reindex of 69M-row-a-day target, English-only. | P5 cost, DBA-heavy. |
| D. Trigram `word_similarity` threshold | Fuzzy, finds typos and variants. | Threshold tuning, noisy results, slower. | P4 (noise) at risk. |

### 5.2 Which side is searched
Both original and current translation, as today (ADR-0025). Not reopened.

### 5.3 PostgreSQL extensions
`pg_trgm` is already in use and is the whole mechanism. No new extension. Core fallback: with the trigram index off, Latin substring leaves scan; the search page must show a notice when `trgm_index = off` (P3 honesty about degraded mode).

## 6. Decisions needed
| ID | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | How "startups" finds "startup" | A literal substring, B substring + suffix trimming, C English stemming, D fuzzy | B |
| D2 | What "exact matches rendered within quotes" means | (i) quoted input is the exact syntax and the echo shows exact terms in quotes; (ii) also label each result card with how each term matched, exact in quotes versus substring | (i) now; (ii) is extra per-row work and can follow |
| D3 | Scope of English-first on search cards | (i) headline pair only, excerpt stays original; (ii) also show the English excerpt under "Show more" with the original behind a reveal | (ii) is the full request ("full text") but needs `left(t.body_en, 600)` added to the search query and a card control; (i) is smaller |
| D4 | Not-yet-translated foreign articles | (i) show original as primary with a "translation pending" note, (ii) show original and no note | (i) (P3) |

ADRs these would supersede or amend once decided: ADR-0005 (bare terms mean substring; quoted means exact), ADR-0007 (leaf kind chosen by script AND length/quoting, Latin now substring), ADR-0026 (English becomes the primary line, not the muted second line), ADR-0024/0025 display clauses (article page swap becomes reveal-below).

### Decisions recorded
- D1 → ADR-0030: English stemming index (the architect had recommended option B; the user chose C). Consequence: this feature **does** need a migration (new generated column and GIN on both tables); sections 1 and 5.3 above, written before the decision, said none was expected. Whether literal substring stays as an OR is open (section 13).
- D2 → ADR-0031: quotes are the exact syntax, echo shows them.
- D3 → ADR-0032: headline and excerpt; English first on cards and article page; untranslated shows original with a pending note.

- **2026-10-28 backtrack → ADR-0036:** the user restored the required query language (bare terms exact; `*` wildcard; case-sensitive keywords). Default stemming and substring matching (D1, ADR-0030, ADR-0033) are superseded: stemming now applies only to `*` terms (prefix OR English stem); summaries stay searchable; ADR-0032 display is unchanged. Sections 1, 4.2, 5.1 and 12 above describe the superseded default and are kept for history; search spec 0003 (rewritten) is authoritative for search behaviour, together with ADR-0034, 0035 and 0036.

## 7. Points of failure
| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-1 | Stem function over-trims (for example "bus" → "bu", "news" → "new") | False positives; trusted results dilute | P4 | Minimum stem length 4, golden tests on short words |
| FP-2 | Stem function under-trims or is skipped on one operator (phrase, wildcard, NOT, one side) | "startups" misses "startup" on one side | P3 | Operator-by-side test matrix (extends FP-S1) |
| FP-3 | Short term (1-2 characters) routed to ILIKE | Sequential scan, search exceeds the 2 s timeout | P1 | Length rule test, EXPLAIN on short terms |
| FP-4 | `pg_trgm` index absent | Latin substring leaves scan | P1 | `trgm_index` flag check, search latency metric by leaf kind |
| FP-5 | ILIKE metacharacters in user input (`%`, `_`, `\`) | Wrong matches or injection-like behaviour | P2 | Existing `escapeIlike`; extend tests to Latin terms |
| FP-6 | English headline shown but translation is stale for a new article version | Wrong English next to new original | P8 | Existing `article_version` join; keep version test |
| FP-7 | Card shows empty primary line when `headline_en` is null for a translated article | Blank title | P3 | Fallback to original, component test |
| FP-8 | Quoted exact term accidentally substring-matched | User cannot get precision back | P7 | Test: `"startup"` does not match "startups" |
| FP-9 | Original reveal control not reachable without JS or by keyboard | Original unreachable | P8 | `<noscript>` fallback kept, keyboard test |

## 8. Resilience design
No new external dependency. Search and display read only the database; failure classes are those already in place (statement timeout, pool exhaustion). Degraded mode: translation missing or pending → original shown with a note; trigram index off → warning banner. No retries are added.

## 9. Hot paths
| ID | Path | Why hot | Load | What needs a human | Measurement |
| --- | --- | --- | --- | --- | --- |
| HP-1 | Search query with ILIKE leaves on both `articles` and `article_translations`, now for every Latin term | Every interactive search; OR across two relations can lose the bitmap plan | Interactive, a few per second | Read EXPLAIN on seeded data for a Latin term, for a stem OR pair, and for NOT with substring | p95 search latency by leaf kind at 100k articles, 30 percent translated |
| HP-2 | Stem function | Runs once per term at compile time, not per row | Negligible | Review the suffix list and minimum length | Golden tests |

## 10. Telemetry starting points
Search latency split by leaf kind (fts, substring-latin, substring-nonlatin); count of searches using stemmed leaves; share of searches using quotes (exact); result count for substring versus exact variants of the same term (optional); share of card renders showing the "translation pending" fallback; use of the original-text reveal control.

## 11. Principle alignment
| Principle | Served by | Cost |
| --- | --- | --- |
| P3 | Substring and stem widen recall; original stays reachable | Lower precision |
| P5 | Per-term classification kept; English display is a UI choice, not a data assumption | English suffix rules only apply to Latin text |
| P7 | Echo distinguishes exact from substring | Echo notation to design |
| P8 | Original always one control away | Extra control |
| P4 | Quotes give a precision path | Users must know the quote syntax |

## 12. Downstream handoff
- carma-searchability: D1, Latin term policy, operator-by-side matrix, echo wording, NOT behaviour, stem rules and min lengths.
- carma-ux: card layout, reveal-below control, echo notation, pending note, D2 and D3.
- carma-dba: confirm no migration; verify the two trigram indexes serve Latin terms; HP-1 plan check; optional: nothing else.
- carma-telemetry: section 10.
- carma-data-sanity: light pass only, ILIKE escaping on Latin terms and escaped rendering of the English text; may be skipped.
- carma-devops: skip, nothing to deploy differently (no migration, no new service, no new setting).
- carma-backend-testing: FP-1 to FP-9, golden cases "startups" and "startup", quote exactness.
- carma-plan: last.
- carma-benchmark after code changes: HP-1. carma-review: keep the stem function and the headline-pair function simple and pure.

## 13. Open questions and assumptions
- UNCONFIRMED: `pg_trgm` is enabled in the target database; the `trgm_index` flag decides.
- UNCONFIRMED: the user's "exact matches in quotes" means D2 option (i).
- UNCONFIRMED: the corpus is mostly English plus Arabic/Chinese, so English suffix rules are enough for Latin text.
- OPEN (for searchability, then confirm with the user): with stemming chosen, should unquoted terms also keep a literal substring OR (trigram) so "start" finds "startup"? The user's words ask for substrings, the choice made gives stems.
- OPEN (for DBA): index size, backfill and write-cost of two new GIN indexes at 800 articles/s; this reverses the "no migration" assumption above.
- Not decided: whether to offer an "exact only" switch in the UI; quoting is the way to turn substring off, so none is proposed.
