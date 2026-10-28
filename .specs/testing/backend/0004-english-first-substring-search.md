---
spec: carma-backend-testing
number: 0004
title: Test plan for stemmed and substring search and English-first display
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/search/0003-english-first-substring-search.md, .specs/data/dba/0004-english-first-substring-search.md, .specs/telemetry/0004-english-first-substring-search.md, .specs/ux/0004-english-first-substring-search.md, .specs/testing/backend/0003-article-translation.md]
principles: [P1, P3, P5, P7, P8]
supersedes: null
---

# 0004 Test plan for stemmed and substring search and English-first display

## 1. Summary and scope
This change adds no pipeline stage and loses no data path, so conservation, ledger and resilience tests from specs 0001 to 0003 are unchanged and not repeated. Scope: query correctness (the compiler), the migration, query plans, display states, the echo, one beacon route, and a write-cost benchmark. Devops spec skipped by choice (nothing new to run); the migration-at-start-up concern is covered here in section 3.5.

The main risks are silent: a term that finds less than it should (recall), a quoted term that finds more than it should, and an index that exists but is not used.

## 2. Test environment and tooling
Existing (ADR-0017): vitest (`npm test`), Playwright (`npm run test:e2e`), real PostgreSQL through `tests/harness/db.ts`, fakes in `tests/fakes/translator.ts`, fixtures in `tests/fixtures/{articles,translation}.ts`, unit tests already including `parse.test.ts`, `search-compile-translation.test.ts`, `translate-display.test.ts`, `metrics-labels.test.ts`, integration `migration-0004.test.ts`, and the quick benchmark `.benchmarks/article-ingest/`. No new tooling. Plan tests need a database with enough rows for the planner to choose indexes, so the harness gains a seeding helper (section 7); `SET enable_seqscan = off` is not a substitute, because it hides the very regression being guarded.

## 3. Integrity invariants and tests
Conservation, fidelity and ledger invariants do not change: no row is written by the new code except index entries. The two data-shaped checks that remain:

### 3.1 Search completeness (P3), integration, real database
Planted corpus (English plus Arabic, French and Chinese rows, each with and without a mock translation). Golden cases from search spec 0003 section 12 become tests in `tests/integration/search-default-match.test.ts` (new):
| # | Case | Expected |
| --- | --- | --- |
| G1 | `startups` over "A new startup raised funds" | found, original side; also found when only the translation contains it |
| G2 | `"startups"` / `"startup"` | `"startups"` misses it, `"startup"` finds it |
| G3 | `start` | found by substring |
| G4 | "Startups", "startup-friendly" | found (case, punctuation) |
| G5 | `startups AND NOT funds` | excluded by original text only; same article is not excluded if "funds" appears only in the translation |
| G6 | `the` (stop word only) | non-zero results by literal text, not zero |
| G7 | terms containing `%`, `_`, `\`, `'` | literal, no error, no extra matches |
| G8 | French article "entreprises", query `entreprise` | found (substring branch) |
| G9 | superseded translation containing the term | not found (version test) |
| G10 | `AI` (2 characters) | found by stem; plan has no sequential scan of text |
| G11 | Arabic term, Chinese term | unchanged results versus the pre-change baseline |
| G12 | Wildcard `start*`, phrase `"venture capital"` | unchanged |
Recall on G1, G3, G8 must be 100 percent. Extra-hit count for 20 ordinary words with and without the broad default is reported, not asserted (precision cost, FP-S10).

### 3.2 Operator-by-side matrix, unit, `tests/unit/search-compile-translation.test.ts` (extend)
For each row of search spec 0003 section 12 (bare term, quoted term, phrase, wildcard, AND, OR, NOT, non-Latin, short term, stop-word-only) assert the compiled SQL text and parameters per side: the stem branch uses exactly `to_tsvector('english', a.search_text)` / `to_tsvector('english', t.search_text)` with `plainto_tsquery('english', $n)`; the quoted form uses the `simple` vector; NOT touches the original side only; parameters are placeholders, never concatenated (FP-S8). Snapshot-style tests are acceptable only for the expression text, since that text must equal the index definition.

### 3.3 Display states, unit and component, `tests/unit/translate-display.test.ts` (extend) and a new `tests/unit/headline-pair.test.ts`
The pure headline-pair function returns the right `{primary, secondary, note}` for every row of UX 0004 section 5.2 (translated; headline missing; body missing; queued, running, failed-retryable; paused; dead; no text; older never scheduled; English; no headline). Component tests (React Testing Library) for `ArticleCard` and `TranslatedText`: English `h2`/`h1` with `lang="en"`, original line with the source `lang` and `dir="auto"`, the two-level reveal on cards, the `<details>` reveal on the article page, stacked (both texts in the DOM when open), `aria-expanded`, no blank primary line (FP-7). RTL (Arabic) and CJK fixtures render without script-specific truncation.

### 3.4 Echo, unit, `tests/unit/parse.test.ts` (extend)
Quoted terms echo in straight double quotes, unquoted bare; multi-word quoted phrase unchanged; the loose-match note appears only when an unquoted Latin term exists; NOT note wording.

### 3.5 Migration, integration, `tests/integration/migration-0007.test.ts` (new; number follows the next migration file)
- File contains `-- no-transaction` and applies through `src/lib/db/migrate.ts` on a database that already holds data.
- Both indexes exist and `pg_index.indisvalid` is true afterwards; the migration fails loudly if one is invalid (FP-DB2).
- Idempotent rerun: second `migrate()` call skips; `CREATE INDEX CONCURRENTLY IF NOT EXISTS` does not error. An invalid leftover index is dropped and rebuilt (test by creating an invalid index manually).
- Inserts continue during the build (run a concurrent insert loop; no errors, no lost rows).
- Rollback: `DROP INDEX CONCURRENTLY` of both leaves search correct (G1, G3 still pass through the substring branch, G1 stem-only case documented as slower, not failing).
- Start-up time of the full migrate on a 100k-row seed is recorded (FP-DB3).

### 3.6 Amendment A (ADR-0035): stemming scope and summaries
Add to `tests/integration/search-default-match.test.ts` the cases G13 to G17 from search spec 0003 (summary-only match, foreign original not stemmed, `und`/`en-GB` stemmed, summary never used by NOT, superseded summary does not match). Seed helper gains summaries through `derived_values` (current and non-current). Plan tests added to `search-plans.test.ts`: **P6** the summary side uses `derived_values_summary_fts_en_idx` and (for substring) `derived_values_summary_trgm_idx`; **P7** the `articles` partial index is used only when the query repeats `split_part(language, '-', 1) IN ('en', 'und')`, and a deliberately altered predicate fails the test (FP-DB1). Migration test now expects four indexes valid. Compile matrix gains the summary side and the language predicate. Component test: marker text for each side combination (UX 0004 section 5.5). New FP rows: FP-DB6 (stale summary after new version, G17 and a worker test that `is_current` flips), FP-DB7 (non-English summary: substring still finds, recorded as accepted degradation).

### 3.7 Amendment B (2026-10-28, ADR-0036): query-language tests
Supersedes the golden cases in 3.1 and 3.6 wherever they assume default stemming or substring. Use the 12 goldens in search spec 0003 section 12 (G1 to G12). Additions and changes:
- Compiler matrix (unit): bare term compiles to the `simple` vector only (no English expression, no ILIKE for Latin); `term*` compiles to prefix on `simple` OR English stem (stem half only for English/`und` originals, all translations and summaries); NOT touches the original side only; stop-word wildcard compiles without the stem half; Arabic/CJK terms still compile to ILIKE.
- **Keyword-case tests (`tests/unit/parse.test.ts`):** `a and b` yields three terms; `a AND b`, `a OR b`, `a AND NOT b` are operators; `NOT` alone is the existing `bare_not` error; `And` and `oR` are terms; nested `(a AND (b OR c))` parses to the expected tree; `"media intelligence"` is a phrase token; `renew*` is a wildcard token; `*` rules produce the existing errors. These cover requirements that already work in `src/lib/search/scan.ts` and `parse.ts` so a later change cannot regress them.
- Plan tests: P1 now asserts the English indexes are used for a `*` query only; a bare-term query must **not** touch them (guards FP-S6); P3, P4 (trigram for Latin) are dropped; P6 covers both summary indexes; P7 language predicate unchanged.
- Migration test expects four indexes valid (`summary_fts_en`, `summary_fts`, not `summary_trgm`).
- Telemetry label tests use kinds `exact`, `wildcard`, `nonlatin_sub`.
- Echo tests: phrase in quotes, `renew*` printed as written, no loose-match note, tip text present.
- B2 benchmark compares `exact` against the pre-change baseline (must not regress) and measures `wildcard` separately.

## 4. Failure-point coverage matrix
| ID | Test | Level | Expected outcome |
| --- | --- | --- | --- |
| FP-1 over-trim / FP-S10 | G-case set plus a short-word list ("bus", "news", "gas") reporting stem collisions | integration | reported, reviewed by a human |
| FP-2, FP-S5 stem missing on an operator or side | 3.2 matrix; G1, G5 | unit, integration | stem predicate present on both sides for positive terms |
| FP-3 short term scan | G10; plan test P3 below | integration | no Seq Scan on `articles` text for `AI` |
| FP-4 trigram off | set `system_flags.trgm_index = off` and drop the trigram index in a test database; run G3 | integration | still correct, slower; UI note shown (component test on the flag) |
| FP-5 metacharacters | G7 | integration | literal match |
| FP-6 stale translation | G9 | integration | not found; headline pair uses current version only |
| FP-7 blank primary | 3.3 | unit, component | never empty |
| FP-8, FP-S6 quoted broadened | G2; compile test for quoted term | unit, integration | exact only |
| FP-9 reveal unreachable | `<details>` present without JavaScript (server render test); keyboard (Playwright: Tab, Enter/Space toggles, focus stays) | component, e2e | reachable |
| FP-S7, FP-DB5 stop-word-only | G6 | unit, integration | fallback, `mss_search_empty_stem_total` increments |
| FP-S8 string-built tsquery | 3.2 asserts placeholders | unit | no concatenation |
| FP-S9, FP-DB1 expression mismatch | plan test P1 | integration | index used |
| FP-DB2 invalid index | 3.5 | integration | fails loudly |
| FP-DB3 slow migration | 3.5 timing | integration | recorded, threshold proposed 60 s at 100k rows |
| FP-DB4 partial predicate | plan test P2 | integration | partial index used |

## 5. Soft requirements
| Claim | Threshold | Method | Evidence |
| --- | --- | --- | --- |
| Search p95, quoted/exact terms | within +25% of the pre-change baseline (proposed) | benchmark B2 | latency table |
| Search p95, stem OR substring | under 2 s (the read timeout; agreed) and proposed under 1 s | benchmark B2 | latency table |
| Ingest throughput with the extra GIN | within 15 percent of today (proposed; DBA 0004 E1) | benchmark B1 | rows/s before and after |
| 15-minute freshness | unchanged; the ingest benchmark must not regress it | existing | existing report |
No soak or 800/s test is added: the PoC rate is 0.58 articles/s and the 800/s write cost is answered by B1 as an extrapolation, labelled as such.

## 6. Hot path measurements
| ID | Measurement | Human-inspection trigger |
| --- | --- | --- |
| HP-1, HP-S1, HP-DB2 | EXPLAIN (ANALYZE, BUFFERS) for: stem-only term, stem OR substring, NOT with substring, rare versus common term, at 100k articles with 30 percent translated; compare current OR/EXISTS shape with the `IN (...) UNION` alternative (DBA E3) | A Seq Scan on text, a Bitmap Heap Scan marked lossy with large recheck, or p95 above threshold: a person reads the plan and chooses the query shape |
| HP-2 | none needed (no stem function in code any more; stemming is in Postgres) | n/a |
| HP-DB1 | B1 benchmark | rows/s drop over 15 percent: a person decides keep, drop one GIN, or accept |

Plan tests (integration, `tests/integration/search-plans.test.ts`, new), run on a seed of at least 20,000 articles with 30 percent translated and `ANALYZE` run:
- **P1** For `startups`, the plan contains a Bitmap Index Scan on `articles_fts_en_idx` and on `article_translations_fts_en_idx`. A mismatched expression in the compiler makes this fail (FP-DB1).
- **P2** The translation-side predicate includes `superseded_at IS NULL` and uses the partial index.
- **P3** For `AI` and for a stop-word fallback, no Seq Scan over `articles` text.
- **P4** For `start` (substring), the plan uses `articles_trgm_idx`.
- **P5** Common term: p95 and plan type recorded; rare term: bitmap path chosen.
Keep these as plan-shape assertions (node types), not timing assertions, so they are stable in CI.

## 7. Load generator and test data specification
Reuse `.benchmarks/article-ingest/bench-lib.mjs` (seeded generator). Extend with: a Latin-heavy vocabulary containing inflection pairs (startup/startups, enterprise/enterprises, news), 30 percent foreign rows with mock translations through `tests/fakes/translator.ts`, and planted terms at a known rate (1 percent). Seeded, reproducible; record hardware, PostgreSQL 16.6 settings and row counts with every result. Synthetic data only (existing policy).

## 8. Resilience and negative tests
No new dependency, so no new retry, breaker or dead-letter behaviour. Negative inputs for the query box (unit/integration): empty query; only quotes; unbalanced quote (existing `unclosed_phrase`); 500-character query; 20 terms; terms with NUL, zero-width and bidi control characters; a term of 1 character; mixed Arabic and Latin in one term; SQL-looking input. Expected: a clear parse error or a safe result, never a 500, never a plan with a Seq Scan caused by a short term. Fault: a statement timeout on a slow stem OR substring query returns the existing timeout response and increments `mss_search_timeouts_total` (integration with a very low `statement_timeout`).

## 9. Security and sanity tests
- XSS: English excerpt and original excerpt containing `<script>`, event-handler attributes and HTML entities render as text (component test; `TextBlock` renders as text).
- The echo prints user terms escaped (component test with `<img onerror>` in a term).
- Query text is not logged (log redaction test extended with the `search.done` event).

## 10. Test levels and when they run
| Suite | Level | When |
| --- | --- | --- |
| compile matrix, echo, headline-pair, display, beacon enum | unit | every commit |
| component tests (card, article page) | unit (jsdom) | every commit |
| `search-default-match`, `migration-0007` | integration (real PostgreSQL) | every commit |
| `search-plans` | integration (seeded 20k rows) | every commit if under about 60 s, otherwise nightly |
| keyboard and no-JS reveal | Playwright e2e | nightly and before release |
| B1 ingest regression, B2 search latency | benchmark (carma-benchmark) | on demand after code changes and before release |
Beacon enum test (unit, `tests/unit/translation-view-route.test.ts`, new): `original_shown` and `original_hidden` are accepted and increment `mss_translation_view_total`; legacy `translated`/`original` still accepted for one release; anything else is dropped and counted `bad_view`. Label guard: `tests/unit/metrics-labels.test.ts` extended for the new `kind` and `state` values.

## 11. Exit criteria and reporting
Done when: G1 to G12 pass; the operator matrix passes; plan tests P1 to P4 pass; the migration test passes including the invalid-index case; every FP in section 4 has a passing test or a recorded gap; B1 and B2 results are recorded against their thresholds with environment details, with at least three runs and the spread reported. A failed P1 is a blocker (index unused means every search degrades). A B1 miss is a risk to be accepted or mitigated by the user, not a blocker at PoC rate.

## 12. Gaps, risks and open questions
- Gap: no test can prove recall for real foreign-language text in non-English Latin scripts beyond G8; real corpus unknown.
- Gap: real-corpus precision (extra hits) is reported, not judged; a human reviews the list.
- Open: whether `search-plans` fits the per-commit time budget (measure first).
- Open: at target scale (800/s) the index-size and write-cost extrapolation is not tested; it stays an assumption (DBA 0004 section 3).

## 13. Handoff
carma-plan schedules, in order: seeding helper and generator extension; migration test and migration; compiler tests and compiler change; plan tests; list-query change (`body_excerpt_en`); display function and component tests; echo and strings; beacon change; telemetry additions; B1 and B2 via carma-benchmark. carma-benchmark: HP-DB1 (B1) and HP-S1 (B2); read counts from `articles` and `article_translations`. carma-review: the headline-pair function and the compiler expression text must stay simple and match the index definition by eye.
