---
spec: carma-review
number: 0005
title: Review of English-first display and stemmed/substring search, plus whole-tree commit gate
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/plan/0004-english-first-substring-search.md, .specs/architect/adrs/0030-english-stemming-index-for-default-search.md, .specs/architect/adrs/0031-quoted-terms-are-exact-matches.md, .specs/architect/adrs/0033-unquoted-terms-match-stem-or-substring.md, .specs/architect/adrs/0034-english-stem-index-as-expression-index.md, .specs/architect/adrs/0035-stemming-scope-and-summaries-searchable.md, .specs/review/0004-english-first-substring-search.md, reports/english-search-phase1.md]
principles: [P1, P3, P5, P7]
supersedes: null
---

# 0005 Review: English-first search (plan 0004) and commit gate

## 1. Verdict and summary

**Approve with changes.** No secret would be committed, and no silent data-loss path was found. Two items need a fix or a check before the phase gate closes.

What was reviewed: the repository has **no commits** (`git log` fails), so there is no diff. I reviewed the whole untracked tree as "what would be committed", with the code read focused on plan 0004: `db/migrations/0007_english_search_indexes.sql`, `src/lib/search/{leaf,compile,run}.ts`, the `is_current` flip in `src/worker/finish.ts`. I did not read the UI components, telemetry wiring or e2e tests in this pass.

Top findings:
1. **Should fix.** Stop-word term `the` (and any stop word of 3+ chars) registers a bind parameter that no SQL references (`compile.ts:244-246`). PostgreSQL normally rejects this with "could not determine data type of parameter $n". Not run here; integration case G6 (`search-default-match.test.ts:155`) should expose it if it runs against a database. The unit test only checks that `ILIKE` appears.
2. **Should fix.** `/api/search` runs 9 to 10 statements per request, including whole-table counts, so the cost grows with the corpus. The proposal in section 5 cuts this to 4 (precompute the corpus-wide signals, scan the filtered selection once, fold the page lookups, run the rest in parallel). Also, `excluded_by_filter_not_enriched` is always 0 and `articles_in_scope` is the whole corpus, which breaks P3 coverage honesty.
3. **Gate still open.** Plan T1.6 (human EXPLAIN read) and T1.7 (benchmark B1, at 15 percent) have no recorded results; `reports/english-search-phase1.md` says "Record results here when executed".

## 2. Scope reviewed

- Revision: none. No commits exist, so the working tree is the change. 30-odd top-level entries are untracked.
- Plan: `.specs/plan/0004`. Specs and ADRs: ADR-0030 to 0035, `.specs/architect/0004`, DBA and search 0004, telemetry 0004 (listed in the plan front matter). I used the plan's own summary of those ADRs rather than re-reading every one.
- Earlier review `0004-english-first-substring-search.md` (short checklist) was read; this report does not supersede it.
- Not run: the test suites, the benchmark, EXPLAIN. Statements about test results are taken from the repo's own report and are unverified.

## 3. Plan conformance

| Task | Status | Evidence |
| --- | --- | --- |
| T1.2 Migration 0007 | Delivered | Four `CONCURRENTLY` indexes, `-- no-transaction`, invalid leftovers dropped, post-check |
| T1.3 Migration test | Present | `tests/integration/migration-0007.test.ts` exists; not run |
| T1.4 Compiler and matrix | Delivered | `compile.ts`, `leaf.ts`; expression text shared in `EXPR` (FP-DB1) |
| T1.5 List query, sides | Delivered | `run.ts:101-129` `body_excerpt_en`, `matched_in` set; `trgm_index` exposed |
| FP-DB6 `is_current` flip | Delivered | `finish.ts:174` flips `summary` and `topic` |
| T1.6 Golden and plan tests | Partly | Files exist (`search-default-match`, `search-plans`); human plan reading and E2 to E5 reports not recorded |
| T1.7 Benchmark B1 | Not delivered | README section exists; no result recorded; Q5 open |
| Phase 2 (UI, telemetry, e2e) | Not reviewed | Out of this pass |
| Scope creep | None found in files read | |

## 4. Trade-off and spec conformance

| Decision | Status | Evidence |
| --- | --- | --- |
| ADR-0031 quoted = exact | Respected | `classifyLeaf` quoted single word is `exact`, multi-word is `phrase` |
| ADR-0033 unquoted = stem OR substring | Respected | `compile.ts:243-263` |
| ADR-0027/0035 NOT is original-only | Respected | `compile.ts:272-278` |
| ADR-0034 expression indexes, text must match | Respected, fragile | `EXPR` strings equal the migration text; the `articles` predicate is repeated by hand (plan C9); the plan test P7 is the guard |
| PostgreSQL only | Respected | No new infrastructure |
| P3 completeness (no dropped item) | Respected in search | Stop-word fallback goes to substring, not to "no results" |
| P5 language neutrality | Respected with a caveat | Foreign originals are not English-stemmed by design (ADR-0035, C11); non-Latin goes to substring; script detection covers Arabic and CJK ranges only, so Cyrillic, Greek and Hebrew terms would be treated as Latin and stemmed with the English config |
| Parameterised queries | Respected | All terms are bind params; ILIKE escaped by `escapeIlike`; wildcard term stripped to letters and digits |
| Telemetry for changed paths | Unverifiable here | Counter `mss_search_empty_stem_total` seen; rest in T2.6, not read |

## 5. Hot path review

Search compile and list query (HP-1, HP-S1, HP-DB2; not the ingest hot path):

- **Readable.** `compileTerm` is long but flat and explicit, and the per-kind branches are easy to follow. Suggestion: the `side` repetition (`if side === original ... translation ... summary ... both`) appears six times; a small table of `{orig, tr, sum}` builders per kind would remove about 60 lines without adding indirection. Optional.
- **Over-work per request (Should fix).** A search request issues 9 to 10 statements (list, `derived_values`, `enrichment_jobs`, then the coverage group at `run.ts:233-251`). The coverage group is `computeCoverage` (2 to 3 queries, including `count(*) FROM articles` and two `count(DISTINCT article_id) FROM derived_values` over the whole corpus), `computeTranslationCoverage` (one statement with 6 scalar subqueries over the filtered selection), `computeSummaryMissing` (a NOT EXISTS scan), the `system_flags` read, and optionally a count. All run sequentially with `await`. At 69 million rows a day the corpus-wide counts cannot be per request, and no statement budget is stated in the spec.
- **Proposed change: fewer statements, no repeated scans.** In order of value:
  1. *Precompute the filter-independent signals.* Corpus total, enriched sentiment and topic counts, `max(published_at)` and `max(ingested_at)` do not depend on the user's filters. Have the existing `metrics-refresh` worker write them to one small table (or `system_flags` rows) and read them in a single statement. This removes the scans that grow with the corpus.
  2. *Build the filtered selection once.* `computeTranslationCoverage` already uses a `WITH sel AS (...)` over the filters. Add the base-filter count and the summary-missing count to that same statement so the filtered rows are scanned once instead of three times. Fold the `trgm_index` flag read into the precomputed read in step 1.
  3. *Fold the page lookups together.* Fetch `derived_values` and `enrichment_jobs` for the returned ids in one statement, or join them into the list statement with a lateral aggregate, instead of two round trips after the list.
  4. *Run what remains in parallel* with `Promise.all` on separate connections, not sequentially.
  Target: the list query, one page-lookup statement, one precomputed-signals read and one filtered-coverage statement, 4 statements per request, the last three in parallel after the list.
  Limits: keep the list query separate from the coverage statement, so a coverage timeout cannot lose results (P3); a coverage failure should return results with the signal marked unavailable. Do not merge cheap and expensive queries merely to save a round trip. Record the precompute decision as an ADR through carma-architect, since it changes freshness of the coverage line from live to refresh-interval.
  Evidence needed first: statement count and latency of the coverage part on the 20k seed, so the gain is measured (B2 should log both).
- **Dead and misleading code (Should fix).** `computeCoverage` (`run.ts:440-460`): `c1` runs the same query as `baseCount`, so `excluded_by_filter_not_enriched` is always 0; the empty `if` at 441 and `void withDerived` are leftovers. Either compute the real figure or remove the field; a constant 0 reads as "nothing excluded" (P3). Also `articles_in_scope` is the whole-corpus total (`select count(*) from articles`), not the number in scope; rename it or count the real scope.
- **Plan shape (open gate).** `OR` of `EXISTS` across three sides plus `ILIKE` branches may defeat bitmap OR; this is exactly what T1.6 asks a person to read. No EXPLAIN output is recorded.
- **Matched sides.** `matched_in` re-evaluates the predicates only on the outer `LIMIT` rows if the planner does not inline them; E7 timing is not recorded.
- **Measured.** B1 and B2 are not recorded. Do not change the compiler for speed before they are.

## 6. Secrets and sensitive information

**No secret would be committed.** Checked: the whole tree (no history exists) for provider key formats, private key headers, JWT-shaped strings, `password/secret/token/api_key`, disabled TLS verification, CORS headers, internal hosts and private IP ranges; `.gitignore`, `.dockerignore`, `.env.example`, `compose.yaml`, `ops/init-secrets.sh`, the benchmark harness.

- `.env` (git-ignored by `.gitignore:37`, excluded from the Docker context) holds a live-format OpenAI key (`sk-p…`, file line 21). It is correctly ignored, and I searched every other file for its value and found none. **It was printed to this session's tool output by my first pattern scan**, so treat that transcript as sensitive; rotate the key if the transcript is stored or shared.
- `.env.example` has placeholders only. Compose reads database and upload secrets from files generated by `secrets-init`. The benchmark takes admin credentials from environment variables and generates the app password at run time. Published ports bind `127.0.0.1` by default.
- `.specs/review/0001` mentions pattern names only, no values.
- Before the first commit, run `git status --ignored` to confirm `.env` stays out, and consider adding a secret scanner (gitleaks) to the repo, since there is no history to protect yet.
- Minor: `.env` has fewer keys than `.env.example` (no translate or upload settings); not a leak.

## 7. Other findings

**Should fix**
- `compile.ts:244-246` unreferenced parameter when `stemEmpty` (see 1). Suggested fix: only call `paramIndex` for the stem value when `!meta.stemEmpty`; add a compile test asserting that every `$n` up to `params.length` appears in the SQL, which covers the whole class.
- `leaf.ts:46-54` `isNonLatin` only covers Arabic and CJK; the data model must work for any language (constraints table). Suggest `\p{Script=Latin}` as the test for "stem_sub" and treat everything else as substring.

**Consider**
- `migration 0007` header comment promises a non-concurrent fallback for missing `pg_trgm` that is not implemented; the build fails instead (acceptable, since 0001 creates the extension). Fix the comment, and the "reserved keyword" check can go (identifiers with underscores cannot be keywords).
- `run.ts:305` calls `classifyLeaf` twice per term.
- Rename or document the `query` label reuse (plan C6).

**Praise**
- Single source of truth for index expression text (`EXPR`) with a snapshot test, which addresses the most fragile part of ADR-0034.
- Concurrent, re-runnable migration with a loud post-check.
- Statement timeouts mapped to a clear 503, and echo notes that say plainly what loose matching does.

## 8. Unverifiable items and follow-ups

- Run the unit and integration suites and confirm G6 passes; run `search-plans` on a 20k seed and attach EXPLAIN for `stem OR substring`, `NOT`, rare and common terms (T1.6).
- Run B1 (`node --import tsx .benchmarks/article-ingest/bench.mjs` on a disposable database) and record the result against the 15 percent line; run B2 for search latency.
- Phase 2 files (`ArticleCard`, `TranslatedText`, `MatchedInTag`, telemetry route, alerts) are unreviewed.
- Approve architect spec 0004 and fix its C1 and C3 wording when ready.
- If the search per-request cost is reduced by caching coverage counts, record it as an ADR through carma-architect.
