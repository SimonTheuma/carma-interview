---
spec: carma-plan
number: 0004
title: Plan for English-first display and default stemmed/substring search
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/architect/adrs/0030-english-stemming-index-for-default-search.md, .specs/architect/adrs/0031-quoted-terms-are-exact-matches.md, .specs/architect/adrs/0032-english-first-display-with-original-underneath.md, .specs/architect/adrs/0033-unquoted-terms-match-stem-or-substring.md, .specs/architect/adrs/0034-english-stem-index-as-expression-index.md, .specs/architect/adrs/0035-stemming-scope-and-summaries-searchable.md, .specs/architect/adrs/0036-stemming-only-with-wildcard.md, .specs/search/0003-english-first-substring-search.md, .specs/data/dba/0004-english-first-substring-search.md, .specs/telemetry/0004-english-first-substring-search.md, .specs/ux/0004-english-first-substring-search.md, .specs/testing/backend/0004-english-first-substring-search.md]
principles: [P1, P3, P5, P7, P8]
supersedes: null
---

# 0004 Plan for English-first display and default stemmed/substring search

## 1. Summary
Build two changes on the shipped translation feature: (1) English-first headlines and text with the original underneath, and (2) the required query language with opt-in breadth: bare words and quoted phrases are exact, `term*` matches by prefix or English stem (ADR-0036, which replaced the earlier default stemming and substring design on 2026-10-28), and summaries become searchable. Two phases, about 20 to 28 hours in total. Critical path: migration (four concurrent indexes) → compiler → list query → plan tests → UI. The database and query work (phase 1) must land before the UI (phase 2) can show matched sides and English excerpts.

## 2. Inputs
All specs and ADRs in the front matter, present and read. Skipped by choice: carma-devops (nothing new to run; the migration-at-start-up concern is a task here) and carma-data-sanity (ILIKE escaping and escaped rendering are covered in test tasks). Mode: sequential. Specs were amended in place (still drafts) after the late decisions in ADR-0035; they were not re-run.

## 3. Blockers and open questions
No blockers. Open items to track (all have a safe default):
| # | Item | Owner | Default if unanswered |
| --- | --- | --- | --- |
| Q1 | Summary language: assumed English | Human, check 20 real summaries in phase 1 | English |
| Q2 | Wording of the "no summary yet" coverage line | Human | Wording in UX 0004 section 5.5 |
| Q3 | "Machine translated" tag on every translated card | Human | Every card |
| Q4 | `pg_trgm` enabled in the target database (now matters only for Arabic/Chinese terms, as before this feature) | Human | Flag `trgm_index` decides at runtime |
| Q5 | Index size and write cost at 800/s | Human, after B1 | Extrapolation only, labelled |
| Q6 | Keep legacy beacon values one release | Human | Keep |

## 4. Consistency report
| # | Finding | Class | Resolution |
| --- | --- | --- | --- |
| C1 | Architect 0004 sections 1 and 5.3 say "no migration expected"; ADR-0030/0034/0035 require migration 0007 | Note | Decisions recorded section of architect 0004 says so; T1.2 is the migration; edit the two sentences when the architect spec is approved |
| C2 | ADR-0036 (2026-10-28) supersedes ADR-0030, 0031 and 0033 (default stem/substring, quote tip). Search 0003 was rewritten; DBA, telemetry, UX and testing 0004 carry "Amendment B" blocks that override earlier text in those files; architect 0004 sections 1, 4.2, 5.1 and 12 describe the superseded default | Risk | Amendment blocks are authoritative; fold them into the body before approving the specs (T2.8) |
| C13 | Requirement check against the existing code: keywords are already case-sensitive (`src/lib/search/scan.ts`), phrase and `*` wildcard already parse (`parse.ts`); there is no test for lowercase `and` as a term or for nested brackets | Gap | Tests added in T1.4 (testing 0004 section 3.7) |
| C14 | The architect FP register entries FP-1, FP-3, FP-4 and DBA E5 assumed default stemming/substring | Note | Treat as `*`-only; FP-3 and FP-4 no longer apply to Latin terms |
| C3 | Architect 0004 FP-1/HP-2 describe an application stem function; stemming is now Postgres's English config | Note | Treat FP-1 as "stem collisions" only; HP-2 is void |
| C4 | ADR-0030 says "generated"; ADR-0034 supersedes that wording | Note | ADR-0034 governs |
| C5 | DBA 0001 says nothing updates `articles`; versions now update it (`0003_article_versions.sql`) | Note | The new partial index is maintained on update; covered by the version test |
| C6 | Telemetry reuses the `query` label key for index names and uses `kind` with different value sets on two metrics | Risk | Acceptable under the label allow-list; rename in a follow-up if confusing; T2.6 checks the label test |
| C7 | UX 0004 open question: `ArticleCard` sets `lang` of the AI summary from the article language, wrong if the summary is English | Risk | T2.2 checks and fixes `lang="en"` for summaries if Q1 is yes |
| C8 | Search on summaries only works after enrichment; unenriched articles miss summary matches | Risk | Coverage line (T2.4); P3 |
| C9 | The `articles` partial index predicate must be repeated textually by the query | Risk | Plan test P7 (T1.6) |
| C10 | Quoted-term matching on summaries has no dedicated index (rechecked on narrowed rows) | Risk | Experiment E9 in T1.6; add an index only if the plan test shows a problem |
| C11 | Late decision: foreign originals are not English-stemmed. Recall for English words inside foreign originals depends on the substring branch | Note | Golden cases G8, G14 document it |
| C12 | Unvalidated assumptions from the context file: real foreign share, article size, PostgreSQL extension permissions | Risk | First experiment in T1.6 replaces the guesses |
No principle conflict is unrecorded: P3 over P4 (broader default) is ADR-0033; precision path is ADR-0031.

## 5. Dependency graph
| Task | Depends on |
| --- | --- |
| T1.1 Seed helper and fixtures | none |
| T1.2 Migration 0007 | T1.1 (for the test) |
| T1.3 Migration test | T1.2 |
| T1.4 Compiler and operator-matrix tests | none (parallel with T1.2) |
| T1.5 List query and match sides | T1.2, T1.4 |
| T1.6 Integration golden and plan tests | T1.3, T1.5 |
| T1.7 Benchmark B1 and review gate | T1.6 |
| T2.1 Headline-pair function | none (can start in phase 1) |
| T2.2 Search card | T1.5, T2.1 |
| T2.3 Article page | T2.1 |
| T2.4 Echo, notes, strings, coverage line | T1.4 |
| T2.5 Matched-side marker | T1.5 |
| T2.6 Beacon, metrics, alerts, dashboards | T1.5, T2.3 |
| T2.7 End-to-end keyboard and no-JS tests | T2.2, T2.3 |
| T2.8 Benchmark B2, review gate, spec close-out | T2.2 to T2.7 |
```
T1.1 → T1.2 → T1.3 ─┐
T1.4 ───────────────┼→ T1.5 → T1.6 → T1.7 → [phase 2]
T2.1 ─(parallel)────┘
```
Critical path: T1.1, T1.2, T1.5, T1.6, then T2.2/T2.5, T2.7, T2.8. Parallel: T1.4 and T2.1 can run beside the migration work (different files).

## 6. Phases

### Phase 1: Search data layer and query (about 11 to 15 hours)
Goal: bare and quoted terms stay exact across original, translation and summary; `term*` matches by prefix or English stem; the query-language requirements are covered by tests; plans use the new indexes only for wildcard terms.
Entry criteria: ADR-0030 to 0035 accepted (done); no blockers.
Rollback or safe-stop: drop the four indexes concurrently; the compiler change is behind the same commit, so revert it too. Search then returns to the previous behaviour; no data changed.
Human checkpoints: T1.6 plan inspection; T1.7 benchmark review.

**T1.1 Add seeding helper and fixtures** (agent, 1 to 2 h)
- Why: plan tests and golden cases need 20,000+ articles with foreign rows, translations and summaries (testing 0004 sections 3.1, 7).
- Steps: extend `tests/harness/db.ts` with a seeded bulk loader; extend `tests/fixtures/articles.ts` and `tests/fixtures/translation.ts` with inflection pairs (startup/startups, enterprise/enterprises, news), `und` and `en-GB` labels, Arabic/French/Chinese rows, current and non-current summaries via `derived_values`; reuse the seeded generator in `.benchmarks/article-ingest/bench-lib.mjs`.
- Where: `tests/harness/db.ts`, `tests/fixtures/`.
- Output: a helper that seeds N rows with a fixed seed and runs `ANALYZE`.
- Acceptance: deterministic row counts across two runs; foreign share 30 percent.
- Depends on: none. Spec refs: testing 0004 sections 3.1, 7.

**T1.2 Write migration 0007: four concurrent expression indexes** (agent, 2 to 3 h)
- Why: ADR-0030, 0034, 0035; DBA 0004 sections 4 and 4.1; FP-DB1 to FP-DB4.
- Steps: new `db/migrations/0007_english_search_indexes.sql` starting with `-- no-transaction`. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` for: `articles_fts_en_idx` (`to_tsvector('english', search_text)` where `split_part(language, '-', 1) IN ('en','und')`), `article_translations_fts_en_idx` (same expression, `WHERE superseded_at IS NULL`), `derived_values_summary_fts_en_idx` (`to_tsvector('english', value)` where `field = 'summary' AND is_current`), and `derived_values_summary_fts_idx` (`to_tsvector('simple', value)`, same predicate). No trigram index (ADR-0036). Drop any index with `indisvalid = false` first (re-run safe) and fail if one remains invalid. Run `pg_get_keywords()` on the new identifiers.
- Where: `db/migrations/`; the runner in `src/lib/db/migrate.ts` already supports `-- no-transaction`.
- Acceptance: migration applies on an empty and on a seeded database; all four indexes valid; rerun is a no-op.
- Depends on: none (test in T1.3). Estimate note: build time on a large table is unknown (FP-DB3).

**T1.3 Test the migration** (agent, 1 to 1.5 h)
- Steps: `tests/integration/migration-0007.test.ts` per testing 0004 section 3.5 (no-transaction applies, indexes valid, interrupted-build leftover handled, inserts continue during build, drop rollback, build time recorded on 100k rows).
- Acceptance: test passes; recorded build time on the seed.
- Depends on: T1.1, T1.2.

**T1.4 Change the compiler and write the operator-matrix tests** (agent, 3 to 4 h)
- Why: ADR-0035, 0036; search 0003 sections 4, 12; FP-S5 to S8, S11; requirement check C13.
- Steps: in `src/lib/search/leaf.ts` and `compile.ts`: bare and quoted Latin terms compile to the `simple` vector on original, translation and the new summary side (exact, as before this feature); `term*` compiles to prefix (`to_tsquery('simple', 'term:*')`) OR English stem (`plainto_tsquery('english', $n)` on the English expression, which for the original side is used only for English/`und` labels and repeats the `split_part(...) IN ('en','und')` predicate); the translation side keeps `superseded_at IS NULL`; the summary side is an `EXISTS` over `derived_values` with `field = 'summary' AND is_current`. Stop-word wildcards omit the stem half. Arabic/CJK terms stay on ILIKE. NOT stays original-only. Return per-side predicates so `matched_in` can report a set. No change to `scan.ts` or `parse.ts` behaviour; add the keyword-case and nesting tests listed in testing 0004 section 3.7.
- Where: `src/lib/search/leaf.ts`, `compile.ts`, tests in `tests/unit/search-compile-translation.test.ts` and `tests/unit/parse.test.ts`.
- Acceptance: operator-by-side matrix in testing 0004 sections 3.2 and 3.7 passes; no string-built tsquery; expression text equals the migration text; a bare-term query contains no English expression.
- Depends on: none. Human gate: read the generated SQL for one multi-term query.

**T1.5 Update the list query and match sides** (agent, 2 to 3 h)
- Steps: in `src/lib/search/run.ts` add `left(tr.body_en, 600) AS body_excerpt_en`; replace the single `matched_in` with a set of sides (`original`, `translation`, `summary`) computed only for returned rows; keep keyset ordering. No `trgm_index` exposure is needed any more (Latin terms no longer use trigram).
- Where: `src/lib/search/run.ts`, `src/app/api/search/route.ts`, types used by `src/components/search/SearchPage.tsx`.
- Acceptance: response contains `body_excerpt_en` and `matched_in` sides; EXPLAIN shows the `CASE` is not evaluated for non-returned rows (E7 timing check).
- Depends on: T1.2, T1.4. Also verify in `src/worker/finish.ts` that a new summary flips the previous `is_current` (FP-DB6); fix only if wrong.

**T1.6 Golden, plan and experiment tests** (agent with a human reading the plans, 3 to 4 h)
- Steps: `tests/integration/search-default-match.test.ts` (G1 to G17), `tests/integration/search-plans.test.ts` (P1 to P7, node-type assertions on a 20k seed), experiments E2 to E5, E9 to E11 recorded in `reports/` with environment details; run the first sizing experiment (index sizes and build times) and replace the guesses in DBA 0004 section 3; check 20 real summaries for language (Q1).
- Acceptance: all cases pass; recall 100 percent on G1, G3, G8; extra-hit report produced.
- Human checkpoint: a person reads the plans for stem OR substring, NOT, rare and common terms and chooses OR/EXISTS versus the UNION shape (HP-1, HP-S1, HP-DB2).
- Depends on: T1.3, T1.5.

**T1.7 Benchmark B1 and review gate** (agent runs; human decides, 1 to 1.5 h)
- Steps: extend `.benchmarks/article-ingest/` (carma-benchmark) to compare insert rows/s with and without the four indexes at 100k rows; run carma-review on the diff.
- Acceptance: within 15 percent (proposed) or the cost is reported and accepted by the user (Q5).
- Depends on: T1.6.
Phase 1 exit: migration, compiler, query and tests pass; B1 recorded; review report written.

### Phase 2: Display, echo, telemetry (about 10 to 15 hours)
Goal: English-first cards and article page, honest echo and match markers, signals and tests.
Entry criteria: Phase 1 exit; Q1 answered or defaulted.
Rollback or safe-stop: UI changes are independent per component; reverting the card or page returns the old layout without affecting search.
Human checkpoints: T2.2 look at cards with Arabic and Chinese data; T2.8 review.

**T2.1 Write the headline-pair function** (agent, 1 to 1.5 h)
- Why: ADR-0032; FP-6, FP-7. Steps: pure function returning primary, secondary, language codes and note for every UX 0004 section 5.2 state, reusing the job-state mapping in `src/lib/translate/display.ts`. Tests: `tests/unit/headline-pair.test.ts`, extend `tests/unit/translate-display.test.ts`.
- Acceptance: all state rows covered; never an empty primary. Depends on: none.

**T2.2 Rebuild the search card** (agent, 2 to 3 h)
- Steps: `src/components/ArticleCard.tsx`: English `h2` with `lang="en"`, original line labelled "Original (Arabic):", "Machine translated" tag (Q3), state notes, "Show more" → English excerpt, "Show original text" → original excerpt underneath, no-JS handling, summary `lang` fix (C7). Retire `englishHeadline` and related strings in `src/lib/ui/strings.ts`.
- Acceptance: component tests (testing 0004 section 3.3) pass; manual look at Arabic and Chinese cards at phone and desktop widths.
- Depends on: T1.5, T2.1.

**T2.3 Rebuild the article-page text block** (agent, 2 h)
- Steps: `src/components/TranslatedText.tsx` and `src/app/articles/[id]/page.tsx`: headline pair, English body, native `<details>` revealing the original underneath (translation stays visible), remove swap and min-height trick, live announcement, beacon on `toggle`.
- Acceptance: stacked content, keyboard operable, works with JavaScript disabled. Depends on: T2.1.

**T2.4 Echo, notes, strings, coverage line** (agent, 1.5 to 2 h)
- Steps: `src/lib/search/echo.ts` (already prints phrases in quotes and `renew*`; confirm, no change expected) and `SearchPage.tsx`: wildcard tip text, "no exact matches, try adding *" hint for bare-term zero results, no-summary coverage line (Q2). Strings in `src/lib/ui/strings.ts` (UX 0004 section 10, revised list).
- Acceptance: echo tests (testing 0004 sections 3.4, 3.7); XSS check on terms. Depends on: T1.4.

**T2.5 Update the matched-side marker** (agent, 1 h)
- Steps: `src/components/MatchedInTag.tsx` for sets of sides and summary copy (UX 0004 section 5.5). Acceptance: marker text per combination. Depends on: T1.5.

**T2.6 Add beacon values, metrics, alerts, dashboards** (agent, 2 to 3 h)
- Steps: update the route `src/app/api/telemetry/translation-view/route.ts` (new values, keep legacy one release, Q6); add series in `src/lib/metrics.ts` (check `tests/unit/metrics-labels.test.ts`); emit from compiler, search route and status refresher; alerts E1 to E3 in `ops/alerts.yml`; Grafana search row in `ops/grafana/`; log fields without query text.
- Acceptance: beacon enum test (`tests/unit/translation-view-route.test.ts`); series visible on `/api/metrics`; alert rules load. Depends on: T1.5, T2.3.

**T2.7 End-to-end tests** (agent, 1 to 1.5 h)
- Steps: Playwright: keyboard toggles, focus stays, no-JS article page reveal, card two-level reveal, RTL fixture. Where: `tests/e2e/smoke.spec.ts` or a new spec. Depends on: T2.2, T2.3.

**T2.8 Benchmark B2, review gate, close-out** (agent plus human, 1.5 to 2 h)
- Steps: carma-benchmark for search latency by term kind (B2); carma-review on the phase diff; update README search syntax section; ask the user to approve the architect spec 0004 (then set approved and fix C1, C3).
- Acceptance: B2 within thresholds in testing 0004 section 5; review report in `.specs/review/`.
- Depends on: T2.2 to T2.7.
Phase 2 exit: all tests in testing 0004 section 11 pass.

## 7. Traceability matrix
| Requirement / ID | Task | Proof |
| --- | --- | --- |
| English headline first, original underneath (ADR-0032) | T2.1, T2.2, T2.3 | headline-pair and component tests, e2e |
| English text first, original on request | T2.3 | component test, e2e no-JS |
| AND, OR, AND NOT; nested brackets; quoted phrases; case-sensitive keywords (requirements) | T1.4, T1.6 | G3 to G5, keyword-case tests |
| `renew*` matches renewable, renewables (requirement); `startups*` finds "startup" (ADR-0036) | T1.4, T1.5, T1.6 | G2, plan P1 |
| Bare term stays exact (ADR-0036) | T1.4, T1.6 | G1, bare-term plan guard |
| Summaries searchable (ADR-0035) | T1.2, T1.4, T1.5 | G13, G16, G17, P6 |
| Stem scope (ADR-0035) | T1.4 | G14, G15, P7 |
| FP-1 | T1.6 | collision report |
| FP-2, FP-S5 | T1.4, T1.6 | matrix, G1, G5 |
| FP-3, FP-4 (void for Latin terms after ADR-0036) | n/a | n/a |
| FP-5 | T1.4, T1.6 | G7 |
| FP-6 | T2.1, T1.6 | G9 |
| FP-7 | T2.1, T2.2 | headline-pair, component tests |
| FP-8, FP-S6 | T1.4, T1.6 | G2 |
| FP-9 | T2.3, T2.7 | no-JS and keyboard e2e |
| FP-S7, FP-DB5 | T1.4, T1.6 | G6 |
| FP-S8 | T1.4 | placeholder assertions |
| FP-S9, FP-DB1, FP-DB4 | T1.4, T1.6 | P1, P2, P7 |
| FP-DB2, FP-DB3 | T1.2, T1.3 | migration test |
| FP-DB6, FP-DB7 | T1.5, T1.6 | G17, Q1 check |
| FP-S10 | T1.6 | extra-hit report |
| HP-1, HP-S1, HP-DB2 | T1.6, T2.8 | plans, B2 |
| HP-DB1, HP-S2 | T1.7 | B1 |
| Telemetry signals | T2.6 | beacon test, label test, `/api/metrics` |
No empty cells. HP-2 is void (C3).

## 8. Risks and assumptions
- Estimates: 20 to 28 hours (about 2 hours less than before the backtrack, from dropping the substring branch and the summary trigram index); widest uncertainty is migration build time and plan tuning in T1.2 and T1.6 (plan shape may force the UNION alternative and a second pass).
- Assumed: PostgreSQL 16.6 with `pg_trgm`; summaries are English; the PoC rate (0.58/s), so the 800/s write cost is extrapolation only.
- The partial `articles` index and language predicate is the most fragile part (C9).
- Over-matching is a deliberate P3 trade; users have quotes.

## 9. Execution notes
- Work tasks in dependency order; report each task done with its acceptance evidence. If a plan test fails or B1 misses, stop and return to carma-dba with the plan or timings rather than changing the design in place.
- If summary language turns out not to be English (Q1), return to carma-searchability for the summary side.
- After each phase run carma-benchmark and carma-review as the gate; the user decides on a missed threshold.
- Record any new binding decision as an ADR through carma-architect (next number 0036).
