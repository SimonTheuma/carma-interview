---
spec: carma-review
number: 0006
title: Conformance of the whole codebase to the Senior Fullstack home assignment
status: draft
date: 2026-10-28
feature: assignment-requirements-conformance
inputs: [.specs/references/Senior-Fullstack-Home-Assignment.pdf, .specs/references/sample_articles.json, .specs/architect/adrs/0001-assignment-scope-carma-ready.md, .specs/architect/adrs/0003-enrichment-providers.md, .specs/architect/adrs/0020-upload-endpoint-shared-token.md, .specs/review/0005-english-first-substring-search.md, README.md]
principles: [P2, P3, P5, P6, P7]
supersedes: null
---

# 0006 Review: whole codebase against the assignment brief

Links are relative to this file and open the code a person should read to verify each requirement. Line numbers were read on 2026-10-28.

## 1. Verdict and summary

**Request changes**, mainly for missing README and submission deliverables, not for broken code. The implementation covers almost every functional requirement. No secret would be committed.

What was reviewed: the whole untracked tree (the repository still has no commits, so there is no diff). Read in full: search scanner, parser, compiler, leaf classifier, search runner, filters, cursor, aggregate route, prompt builder, budget ledger, config, Next config, sanitiser entry, `TextBlock`, README, ADR-0001, 0003, 0020 and review 0005. Read in part: worker loop, ingest, validation, `ArticleCard`, trends page.
**Not run**: the test suites, `npm run typecheck`, `docker compose up`, the benchmark, any EXPLAIN. Every "met" below means "the code reads as meeting it", not "observed working".

Top findings:
1. **Blocker.** README "LLM Cost Analysis" has formulas and no numbers. The brief requires a per-article cost breakdown and a projected daily cost at 50,000 articles, plus a model choice justified on cost, quality and latency ([README.md:98-110](../../README.md)).
2. **Blocker.** The README "Reflection" is a placeholder that says to replace it ([README.md:122-126](../../README.md)), and no LLM transcript exists in the repo (`.dockerignore` mentions `docs/transcript`, which is absent). Both are required submission items worth 15 percent.
3. **Should fix.** The headline is placed outside the nonce fence in the LLM prompt ([prompt.ts:50-52](../../src/lib/enrich/prompt.ts)), and the brief says injection attempts are in sample headlines (articles 6 and 18).

## 2. Scope reviewed

- Brief: `Senior-Fullstack-Home-Assignment.pdf`, extracted with `pdftotext`. The first attempt to read the PDF as images failed (no `pdftoppm`), so the text version was used. Sample data: 20 articles.
- Plans and specs: ADR-0001 (assignment scope, 800/s and 15-minute SLO are a documented growth path, not built), ADR-0003, ADR-0020, review 0005. Other ADRs were used only through the README and code comments.
- Earlier review 0005 items: its first three "should fix" items now read as fixed (see section 7). Verified by reading, not by running.

## 3. Requirement-by-requirement verification map

Status: **Met** (code reads as meeting it), **Partly**, **Gap**, **Unverified** (needs a run).

### 3.1 Data layer and SQL

| Requirement | Status | Where to verify |
| --- | --- | --- |
| Schema, load the 20 sample articles | Met | Table: [0001_init.sql:31-47](../../db/migrations/0001_init.sql). Loader: [load.ts](../../src/cli/load.ts). Ingest and validation: [ingest.ts:270-302](../../src/lib/ingest/ingest.ts), [article.ts](../../src/lib/validate/article.ts) |
| Efficient filtering by date range, source, language | Met | Keyset indexes with the filter column first: [0001_init.sql:173-175](../../db/migrations/0001_init.sql). Predicates, all bound parameters: [filters.ts:35-54](../../src/lib/search/filters.ts) |
| Paginated list that avoids deep OFFSET | Met | Keyset on `(published_at, id)`: [run.ts:111-126](../../src/lib/search/run.ts) and [run.ts:166-167](../../src/lib/search/run.ts); signed cursor bound to the filters: [cursor.ts](../../src/lib/search/cursor.ts); limit clamp [run.ts:101-103](../../src/lib/search/run.ts); route [search/route.ts](../../src/app/api/search/route.ts) |
| Aggregate by month or week for a filter set | Met, with defects | [aggregate/route.ts:11](../../src/app/api/aggregate/route.ts) (bucket whitelist), series SQL [aggregate/route.ts:69-185](../../src/app/api/aggregate/route.ts); see finding S2 |
| Indexes, with the choices explained in the README | **Gap** | Indexes exist ([0001_init.sql:173-203](../../db/migrations/0001_init.sql), [0007 indexes](../../db/migrations/0007_english_search_indexes.sql)); the README only points at the migration ([README.md:86](../../README.md)) |
| Avoids N+1 and `SELECT *` | Partly | List query names its columns: [run.ts:152-168](../../src/lib/search/run.ts), page lookup is one batched statement but returns whole rows: [run.ts:358-366](../../src/lib/search/run.ts); see S3 |

### 3.2 Boolean search

| Requirement | Status | Where to verify |
| --- | --- | --- |
| `AND`, `OR`, `AND NOT` | Met | Tokens [scan.ts:69-74](../../src/lib/search/scan.ts); precedence and `AND NOT` [parse.ts:78-133](../../src/lib/search/parse.ts); SQL [compile.ts:250-266](../../src/lib/search/compile.ts) |
| Nested brackets | Met | [parse.ts:147-163](../../src/lib/search/parse.ts) (depth limit 8 at [parse.ts:21](../../src/lib/search/parse.ts)) |
| Phrase match with double quotes | Met | Scanner [scan.ts:43-58](../../src/lib/search/scan.ts); SQL `phraseto_tsquery` [compile.ts:149-151](../../src/lib/search/compile.ts) |
| Wildcard `renew*` | Met | Scanner [scan.ts:75-76](../../src/lib/search/scan.ts); prefix plus English stem [compile.ts:197-217](../../src/lib/search/compile.ts) |
| Keywords case-sensitive, lowercase `and` is a term | Met | Exact string compare in [scan.ts:69-74](../../src/lib/search/scan.ts); unit tests in [parse.test.ts](../../tests/unit/parse.test.ts) (not run) |
| The three example queries | Unverified | Golden table [README.md:89-96](../../README.md); integration tests [search-default-match.test.ts](../../tests/integration/search-default-match.test.ts). Note: example 3 returns no rows by design (README says so) |
| Approach and trade-offs explained in README | Partly | One paragraph at [README.md:84](../../README.md); no trade-off discussion (hand-rolled parser vs `websearch_to_tsquery`) |

### 3.3 LLM enrichment

| Requirement | Status | Where to verify |
| --- | --- | --- |
| Summary (1-2 sentences) | Met | Prompt rule [prompt.ts:5-12](../../src/lib/enrich/prompt.ts); output check [validate-output.ts](../../src/lib/enrich/validate-output.ts) |
| Sentiment: positive, negative, neutral, mixed | Met | jev adapter [jev.ts](../../src/lib/providers/jev.ts); schema [0001_init.sql:98-119](../../db/migrations/0001_init.sql) |
| 1-3 topic tags | Met | Prompt rule [prompt.ts:9](../../src/lib/enrich/prompt.ts); vocabulary [topics.ts](../../src/lib/enrich/topics.ts) |
| Model choice justified (cost, quality, latency) | **Gap** | Reasoning is in [ADR-0003](../architect/adrs/0003-enrichment-providers.md), which says the cost analysis is "blocked"; not in the README ([README.md:84-85](../../README.md)) |
| Cost estimate at 50,000 articles a day | **Gap** | [README.md:98-110](../../README.md) is a formula; [measurements.md:13-14](../../reports/measurements.md) says "awaiting keys" |
| At least one cost guardrail | Met (several) | Daily ledger [budget.ts:16-33](../../src/worker/budget.ts); reserve before call [loop.ts:615](../../src/worker/loop.ts); input token cap [prompt.ts:41-48](../../src/lib/enrich/prompt.ts) and [config.ts:72](../../src/lib/config.ts); reuse by input hash [finish.ts:354-385](../../src/worker/finish.ts); breaker [breaker.ts](../../src/worker/breaker.ts); retries capped [config.ts:78](../../src/lib/config.ts) |
| Mocking allowed with realistic outputs and a note on the real integration | Met | Mock [mock.ts](../../src/lib/providers/mock.ts), real adapter [openai.ts](../../src/lib/providers/openai.ts), labelled fallback ADR-0013, origin `mock` recorded [0001_init.sql:83](../../db/migrations/0001_init.sql) |

### 3.4 Full-stack surface

| Requirement | Status | Where to verify |
| --- | --- | --- |
| Search page: boolean input, summary, sentiment badge, topic tags | Met | [SearchPage.tsx:348](../../src/components/search/SearchPage.tsx) renders [ArticleCard.tsx](../../src/components/ArticleCard.tsx): summary [line 150](../../src/components/ArticleCard.tsx), sentiment with confidence [lines 153-173](../../src/components/ArticleCard.tsx) |
| Aggregate view with at least one filter dimension | Met | [TrendsPage.tsx](../../src/components/trends/TrendsPage.tsx) (chart with `aria-label` at line 372, plus a table); filters [FilterBar.tsx](../../src/components/FilterBar.tsx); split by sentiment, topic or language in [aggregate/route.ts:72-159](../../src/app/api/aggregate/route.ts) |
| Runnable with a simple setup | Unverified | `docker compose up -d --build --wait` ([README.md:8](../../README.md)); stack [compose.yaml](../../compose.yaml); smoke [scripts/smoke.sh](../../scripts/smoke.sh). Not run here |

### 3.5 Responsible coding

| Requirement | Status | Where to verify |
| --- | --- | --- |
| SQL injection: parameterised or whitelisted | Partly | Search terms and filters are all `$n` binds ([compile.ts:77-85](../../src/lib/search/compile.ts), [filters.ts](../../src/lib/search/filters.ts)); `ILIKE` escaped [leaf.ts:68-70](../../src/lib/search/leaf.ts); bucket whitelisted [aggregate/route.ts:11](../../src/app/api/aggregate/route.ts). **Exception:** dates are interpolated as SQL literals at [aggregate/route.ts:195-200](../../src/app/api/aggregate/route.ts) (S2). Roles are least-privilege [0001_init.sql:224-250](../../db/migrations/0001_init.sql) |
| XSS: handle the scripted samples (articles 6, 18) | Met | Three layers. (1) Markup reduced to text at ingest, with a record of what was removed: [reduce.ts:20-80](../../src/lib/sanitise/reduce.ts) called from [ingest.ts:301-302](../../src/lib/ingest/ingest.ts). (2) Text rendered as React text, never as HTML: [TextBlock.tsx:14-22](../../src/components/TextBlock.tsx), and `dangerouslySetInnerHTML`, `innerHTML` and `eval` appear nowhere in `src` (searched). (3) CSP and header set: [next.config.ts:20-32](../../next.config.ts). Weakness: `script-src 'unsafe-inline'` ([next.config.ts:28](../../next.config.ts)). Tests: [sanitise.test.ts](../../tests/unit/sanitise.test.ts) |
| Prompt injection: document and ideally implement one mitigation | Partly | System rules + random nonce fence [prompt.ts:4-12](../../src/lib/enrich/prompt.ts) and [prompt.ts:36-53](../../src/lib/enrich/prompt.ts); heuristic detector, flagged low trust, never dropped [inject-detect.ts](../../src/lib/enrich/inject-detect.ts) used at [loop.ts:176-177](../../src/worker/loop.ts); output validated before storing [validate-output.ts](../../src/lib/enrich/validate-output.ts); vocabulary constrained. **Gap:** headline is outside the fence (S1) |
| Cost and rate guardrails | Met | Same entries as 3.3; rate and concurrency limits [config.ts:73-80](../../src/lib/config.ts); upload limits [gate.ts](../../src/lib/upload/gate.ts), [rate-limit.ts](../../src/lib/upload/rate-limit.ts) |
| Duplicate detection | Met | Unique `(source, external_id)` [0001_init.sql:46](../../db/migrations/0001_init.sql), content hash [0001_init.sql:40](../../db/migrations/0001_init.sql), cache by input hash [finish.ts:354](../../src/worker/finish.ts) |

### 3.6 Sample-data edge cases named in the brief

| Case | Status | Where to verify |
| --- | --- | --- |
| Articles 6 and 18: HTML or script injection | Met | See XSS row; fixture [articles.ts](../../tests/fixtures/articles.ts); data [sample_articles.json](../references/sample_articles.json) |
| Articles 8 and 9: Arabic and Chinese | Met, one doubt | Substring path for non-Latin terms [leaf.ts:48-66](../../src/lib/search/leaf.ts); `dir="auto"` and `lang` on text [TextBlock.tsx:17-21](../../src/components/TextBlock.tsx). Doubt: see C1 |
| Article 17: empty headline | Met | Headline nullable with a check that one of headline or body exists: [0001_init.sql:38-45](../../db/migrations/0001_init.sql); validation [article.ts](../../src/lib/validate/article.ts) |

### 3.7 Submission items

| Item | Status | Where |
| --- | --- | --- |
| Working code, simple setup | Unverified | [README.md:6-11](../../README.md) |
| README: Plan | Partly | [README.md:75-79](../../README.md) points at plan files and says "nothing was cut"; the brief asks for the plan made before coding and what would be cut |
| README: Architecture and Decisions | Partly | [README.md:81-96](../../README.md); lacks index rationale and model trade-offs |
| README: LLM Cost Analysis | **Gap** | [README.md:98-110](../../README.md) |
| README: Security and Responsibility | Met | [README.md:112-120](../../README.md) |
| README: Reflection | **Gap** | [README.md:122-126](../../README.md); notes in [reflection-notes.md](../../docs/reflection-notes.md) are technical, not a reflection |
| LLM transcript | **Gap** | Not found anywhere in the tree |

## 4. Trade-off and spec conformance

| Decision | Status | Evidence |
| --- | --- | --- |
| ADR-0001 assignment scope, 800/s not claimed | Respected | [README.md:128-136](../../README.md) |
| PostgreSQL only | Respected | Queue, ledger and flags are tables ([0001_init.sql:49-136](../../db/migrations/0001_init.sql)) |
| P3 nothing dropped | Respected | Injection flagged not dropped ([loop.ts:177](../../src/worker/loop.ts)); quarantine tables [0001_init.sql:151-160](../../db/migrations/0001_init.sql) |
| P6/P7 confidence with origin and range | Respected | Columns and check [0001_init.sql:98-119](../../db/migrations/0001_init.sql); shown with a "why" panel [ArticleCard.tsx:153-173](../../src/components/ArticleCard.tsx) |
| ADR-0020 upload token required | **Violated** | The route does not check a token; the unit test asserts open access ([upload-auth.test.ts:7-16](../../tests/unit/upload-auth.test.ts)); README says "no upload token is required" ([README.md:39](../../README.md)) |
| ADR-0027/0035 NOT excludes by original text only | Respected, with a visible caveat | [compile.ts:256-262](../../src/lib/search/compile.ts); user is told at [run.ts:281-283](../../src/lib/search/run.ts) |

## 5. Hot path review

Search compile and list (HP-1, HP-S1): readable and flat; the repeated four-way `side` branching in [compile.ts:219-248](../../src/lib/search/compile.ts) is long but easy to follow. The statement count per request is down to the list query, then three in parallel ([run.ts:193-197](../../src/lib/search/run.ts)), which meets the proposal in review 0005. No measurement is recorded (`reports/english-search-phase1.md` still says to record results), so no change is recommended for speed.
Aggregate route: not a designated hot path, but it is the least readable file reviewed. Four near-identical SQL blocks, a half-finished parameter scheme and dead code ([aggregate/route.ts:187-203](../../src/app/api/aggregate/route.ts)). See S2.

## 6. Secrets and sensitive information

**No secret would be committed.** Checked: the whole tree for OpenAI, AWS, GitHub, JWT and private-key formats (names only, values not printed), TLS-verification switches, published ports, `.gitignore` and `.dockerignore`.
- The only file with a key-like string is `.env`, which is ignored ([.gitignore:37](../../.gitignore), confirmed by `git check-ignore`) and excluded from the image ([.dockerignore](../../.dockerignore)). I did not open it. Same advice as review 0005: it holds a live-format key, so rotate it if it ever left this machine, and run `git status --ignored` before the first commit.
- [.env.example](../../.env.example) is placeholders. Ports bind `127.0.0.1` ([compose.yaml:143](../../compose.yaml), lines 247 and 273).
- Minor: [config.ts:216](../../src/lib/config.ts) falls back to a fixed cursor secret when none is configured. Cursors are only integrity-protected, so the impact is low, but a missing secret should fail in production instead of silently using a public value.

## 7. Other findings

**Blocker**
- **B1** README cost analysis without numbers ([README.md:98-110](../../README.md)). Fix: run ten real articles or use published list prices, write tokens in and out per article, per-article cost for each provider, the 50,000-a-day total, and the effect of the cache and the daily cap. If keys are not available, say plainly that prices are the published list prices and show the arithmetic. Add one paragraph per model on cost, quality and latency.
- **B2** Reflection placeholder and missing transcript ([README.md:122-126](../../README.md)). Fix: write the reflection in your own words (where the AI helped, where it was wrong, what you would change) and export the chat history into the repo. This is yours to write; I did not draft it.

**Should fix**
- **S1** Headline outside the injection fence ([prompt.ts:50-52](../../src/lib/enrich/prompt.ts)). Move the headline inside the fenced block, apply the token cap to it, and cap its length (the validator only flags above 1,000 characters, [article.ts:97](../../src/lib/validate/article.ts)). Add a unit test with an injected headline.
- **S2** Aggregate route ([aggregate/route.ts:195-200](../../src/app/api/aggregate/route.ts)): dates are spliced into SQL text with a regex replace. They come from a validated `Date`, so I do not see an injection route (not run), but it breaks the brief's literal rule and invites a regression. Bind them as parameters, delete the dead `aggParams` code ([lines 187-203](../../src/app/api/aggregate/route.ts)), and catch the 2-second statement timeout the way search does ([run.ts:176-183](../../src/lib/search/run.ts)); today it would return a 500.
- **S3** Page lookup returns whole rows ([run.ts:358-366](../../src/lib/search/run.ts)): `to_jsonb(d.*)` and `to_jsonb(j.*)` send `last_error`, `claimed_by`, `reserved_micro` and similar fields to every browser. This is the `SELECT *` pitfall the brief names and a small operational leak. Select only what [ArticleCard.tsx](../../src/components/ArticleCard.tsx) uses.
- **S4** README gaps against the brief: index choices, search trade-offs, a real Plan (see 3.7).
- **S5** ADR drift on upload auth (section 4). Either enforce the token again or write a superseding ADR through carma-architect; the brief does not require auth, so a documented removal is acceptable. Also remove the unused `upload_token` secret and the `token_configured` status field if it stays removed ([status/route.ts:42](../../src/app/api/status/route.ts)).

**Consider**
- **C1** A quoted single non-Latin word (for example `"能源"`) is classed `exact` before the script check ([leaf.ts:58-63](../../src/lib/search/leaf.ts)), so it uses whole-token matching on the `simple` vector. Chinese has no spaces, so it may match only when the word stands alone. Not run; check with sample article 9.
- **C2** CSP allows inline scripts ([next.config.ts:28](../../next.config.ts)). React escaping is the real control; a nonce-based policy would make the XSS story stronger.
- **C3** `NOT` ignores translations and summaries by design (ADR-0027); the note shown to users covers it.

**Praise**
- Review 0005 items closed: unused bind parameter fixed ([compile.ts:200-206](../../src/lib/search/compile.ts)), Latin script test replaces the Arabic/CJK range test ([leaf.ts:48-51](../../src/lib/search/leaf.ts)), coverage signals precomputed ([run.ts:384-416](../../src/lib/search/run.ts)).
- Defence in depth for XSS, with a recorded transformation instead of silent stripping.
- Budget reserve, settle and release is a single atomic update ([budget.ts:16-33](../../src/worker/budget.ts)).

## 8. Unverified items and follow-ups

- Run `npm test`, `npm run typecheck`, `npm run lint`, then `docker compose up -d --build --wait` and `sh scripts/smoke.sh`; none were run in this review.
- Confirm the three example queries and the aggregate numbers from the README table against the running stack.
- Check C1 with article 9; check article 17 renders without a headline.
- Review 0005 follow-ups still open: EXPLAIN reading and benchmark B1.
- Not reviewed in this pass: worker retry and sweeper internals, translation module, upload run, telemetry and Grafana assets, e2e tests.
