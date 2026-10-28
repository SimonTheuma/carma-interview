---
spec: carma-architect
number: 0005
title: Non-Latin quoted and wildcard search, nonce CSP, and NOT semantics
status: approved
date: 2026-10-28
feature: search-and-csp-hardening
inputs: [.specs/review/0006-assignment-requirements-conformance.md, .specs/architect/adrs/0007-substring-leaves-for-cjk-and-arabic.md, .specs/architect/adrs/0027-search-not-original-only-and-trigram-on-translations.md, .specs/architect/adrs/0031-quoted-terms-are-exact-matches.md, .specs/architect/adrs/0035-stemming-scope-and-summaries-searchable.md, .specs/architect/adrs/0036-stemming-only-with-wildcard.md, .specs/search/0003-english-first-substring-search.md]
principles: [P3, P5, P7]
supersedes: null
---

# 0005 Non-Latin quoted and wildcard search, nonce CSP, and NOT semantics

## 1. Summary

Three small findings from review 0006, sized to the assignment (ADR-0001).
- **C1 is a confirmed defect.** Quoted Chinese words and Chinese prefix wildcards miss articles that contain them, which breaks ADR-0007 (recall first) and P3. The fix is a classifier change: decide the match mode by script before looking at quotes.
- **C2 is optional hardening.** A nonce-based CSP is cheap in this app because every page is already dynamic, but five inline `style` attributes force a relaxed `style-src-attr`.
- **C3 is a trade-off, not a defect.** NOT already behaves as ADR-0027 decided; the question is whether to keep it and say so more clearly, or change it.

Main decisions asked: see section 6.

## 2. Requirements digest

Functional: quoted single non-Latin words, quoted non-Latin phrases and non-Latin prefix wildcards must find the articles that contain them; the CSP should stop inline script execution; NOT behaviour must be a stated, defensible choice.
Non-functional: language neutrality for any script (P5), completeness over precision (P3), inspectable behaviour (P7), no new infrastructure, no gold-plating.

## 3. Codebase findings

- `classifyLeaf` returns `wildcard` for any wildcard and `exact` for a quoted single word before the script test ([leaf.ts:58-66](../../src/lib/search/leaf.ts)). `phrase` is chosen only if the quoted text contains whitespace.
- `exact` compiles to `plainto_tsquery('simple', …)`, `phrase` to `phraseto_tsquery('simple', …)`, `wildcard` to `to_tsquery('simple', 'term:*')` ([compile.ts:137-217](../../src/lib/search/compile.ts)). The normaliser does no segmentation ([normalise/index.ts](../../src/lib/normalise/index.ts)).
- **Verified on a scratch PostgreSQL 16.3 instance (UTF-8), using the text of sample articles 8 and 9, run 2026-10-28:**
  - The `simple` parser keeps unbroken Chinese runs as single tokens, splitting only at punctuation: article 9 produced 8 tokens, for example `中国科技企业加速全球化布局` and `这一趋势反映了中国企业在人工智能和云计算领域日益增强的竞争力`.
  - Quoted `"人工智能"` (exact) matched **0** rows; `"云计算"` **0**; `"中国科技企业"` **0**; the whole headline matched **1**. Substring (`ILIKE '%人工智能%'`) matched **1**.
  - Wildcard `中国*` matched 1 (prefix of a token) but `科技*` matched **0**, because 科技 is not at the start of a token.
  - Quoted Chinese phrase `"人工智能 云计算"` (phrase path) matched **0**.
  - Arabic: quoted `"عقارات"` matched **0** while `"العقارات"` matched 1; substring `عقارات` matched 1.
  - Not verified: the end-to-end run through the API and UI (the application stack was not started), and `EXPLAIN` on the trigram path.
- Inline-style usage: five `style={…}` attributes ([TextBlock.tsx:16](../../src/components/TextBlock.tsx), [StatusPage.tsx:135](../../src/components/status/StatusPage.tsx), [TrendsPage.tsx:226](../../src/components/trends/TrendsPage.tsx), [TrendsPage.tsx:362](../../src/components/trends/TrendsPage.tsx), [EnrichmentProgress.tsx:37](../../src/components/upload/EnrichmentProgress.tsx)). No `<script>`, `<Script>` or `dangerouslySetInnerHTML` in `src`. All pages and the root layout are `force-dynamic`. No `proxy.ts` exists. No test or script asserts the CSP.
- CSP today: [next.config.ts:28](../../next.config.ts) allows `'unsafe-inline'` for scripts and styles.
- Next.js 16 guide (`node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`): the nonce is generated in `proxy.ts` per request, needs dynamic rendering, Next attaches it to its own scripts, `'unsafe-eval'` is needed only in dev, `'strict-dynamic'` is recommended.
- NOT: right side compiles against the original only ([compile.ts:256-262](../../src/lib/search/compile.ts)); users are told at [run.ts:281-283](../../src/lib/search/run.ts). The mock translator prefixes `[mock translation]` ([mock.ts:50](../../src/lib/providers/mock.ts)).
- Housekeeping: two accepted ADR files are numbered 0036 (precomputed coverage signals; bare terms exact again). Also ADR-0036 (bare terms) supersedes parts of ADR-0031, so ADR-0031's "quoted single word = exact" is now only a re-statement of ADR-0036.
- Unknown: whether a CJK segmentation extension is available in the target Postgres image (not investigated; out of scope).

## 4. Proposed architecture

**C1: script decides first.** In `classifyLeaf`, test the term for non-Latin letters before the quote and wildcard branches.
- Non-Latin single word, quoted or bare: `substring` (`ILIKE '%term%'` on original, translation and summary, as today for bare terms).
- Non-Latin quoted phrase (spaces): `substring` of the whole normalised phrase, so `"人工智能 云计算"` matches the text with the same spacing. Phrases in unspaced scripts are written without spaces, so this is the natural form.
- Non-Latin wildcard `科技*`: `substring` (a trailing `*` on an unspaced script has no meaning other than "contains"); the parser still counts it as a wildcard for limits.
- Latin terms unchanged: bare/quoted single = exact, quoted multi-word = phrase, `term*` = prefix OR English stem.
- Mixed-script terms (letters from both): treated as non-Latin, as today ([leaf.ts:48-51](../../src/lib/search/leaf.ts)).
- Echo/notes: reuse the existing non-Latin note ([run.ts:276-280](../../src/lib/search/run.ts)); the parsed echo should not show quotes as "exact" for these terms (P7).
- Index use: the trigram index serves terms of 3 or more characters; a two-character Chinese word (many are) is a sequential scan over the filtered set. Acceptable at 20 articles; at scale it is a measured follow-up (migration 0004 trigram on translations, [0001_init.sql:179-189](../../db/migrations/0001_init.sql) for originals).

**C2: nonce CSP (if chosen).** Add `src/proxy.ts` that sets `Content-Security-Policy` with `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in development only), `style-src 'self'`, and `style-src-attr 'unsafe-inline'` for the five inline style attributes (low risk: no script execution). Exclude `/api/*`, `_next/static` and images from the matcher. Remove the CSP from `next.config.ts` and keep the other headers. A CSP test asserts the header shape and that no response carries `'unsafe-inline'` in `script-src`. Verify in the browser pane before enforcing.

**C3: options in section 5.**

## 5. Options considered

**C1 fix**
1. Script-first classification, substring for all non-Latin terms (recommended). No new dependency, follows ADR-0007; cost: matches inside longer words, scan on 1-2 character terms.
2. Add CJK segmentation (a text-search parser extension or app-side segmenter). Better precision and index use; adds an extension and a re-index (one-way door), and Arabic still needs a separate answer. Out of proportion at this scope.
3. Document the limit only. Cheapest; leaves a known miss (P3) in a requirement that names Arabic and Chinese samples.

**C2 CSP**
1. Enforce nonce for scripts, relax `style-src-attr` only (recommended if done). Removes the main gap; cost: one proxy file, a test, and browser verification.
2. Report-only first, enforce later. Safest rollout; at this scope it only adds a step and a reporting endpoint nobody reads.
3. Leave as is and state the residual risk in the README. Zero risk of breakage; React text escaping stays the primary control (review 0006, XSS row).

**C3 NOT**
1. Keep original-only, make the limit visible (recommended): keep ADR-0027, show the NOT note in the UI beside the query (not only in the API response), and mention it in the README. Cost: some foreign articles appear that a reader expects to be excluded; the error direction is extra results, not lost ones (P3).
2. Exclude on original and translation, not on summary. Closer to reader expectation for foreign articles; cost: machine-translation artefacts and the mock translator can hide an article; contradicts ADR-0027.
3. Exclude on any side (original, translation, summary). Truest boolean semantics; highest risk of hiding a relevant article for a word that only exists in a generated text.
4. A per-query switch. Maximum control; new grammar or UI, more tests, more to explain; gold-plating for the assignment.

## 6. Decisions needed

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | C1: how to fix non-Latin quoted/wildcard terms | 1 script-first substring, 2 segmentation extension, 3 document only | 1 |
| D2 | C2: CSP approach | 1 enforce nonce, 2 report-only first, 3 keep and document | 1 |
| D3 | C3: NOT semantics | 1 keep and surface, 2 original + translation, 3 any side, 4 per-query switch | 1 |

## 7. Points of failure

| ID | Failure point | Failure mode and effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-1 | Script test misclassifies a term (digits, punctuation, mixed script) | Latin term sent to substring or non-Latin term to exact: missed or noisy results | P3, P5 | Unit table over scripts (Han, Hiragana, Hangul, Arabic, Hebrew, Cyrillic, Greek, Devanagari, Latin with accents, digits-only) |
| FP-2 | Quoted non-Latin phrase normalised differently from the index text (spacing, NFKC) | Phrase misses | P3 | Integration test on articles 8 and 9; the term goes through `normaliseText` as the index does |
| FP-3 | 1-2 character non-Latin terms scan the table | Slow search at scale | P1 | Plan reading on the trigram path; statement timeout already maps to a 503 note ([run.ts:176-183](../../src/lib/search/run.ts)) |
| FP-4 | Proxy matcher covers an API route or a static asset | Broken responses or missing CSP | P2 | Header test per route class |
| FP-5 | A nonce is missing on a Next-injected script | Blank page under enforcement | P2 | Browser run of every page with console errors checked |
| FP-6 | Inline `style` attributes blocked | Progress bars and chart swatches lose colour | P2 | Visual check of status, trends, upload pages |
| FP-7 | NOT hides or shows the wrong article for a foreign article | Surprising results | P3, P7 | Golden test with a translated article containing the excluded word |

## 8. Resilience design

No new dependency is added, so no retry, breaker or queue changes. Search keeps its 2 second statement timeout and clear 503 note ([0001_init.sql:250](../../db/migrations/0001_init.sql)); substring scans on short terms rely on it as the bound (FP-3).

## 9. Hot paths

| ID | Path | Why hot | What needs a human | Measurement |
| --- | --- | --- | --- | --- |
| HP-1 | `classifyLeaf` and `compileTerm` | Run for every query term | Read the branch order once; confirm no Latin regression | Unit table (FP-1) |
| HP-2 | Substring leaf over `search_text` | Sequential scan for short terms | Read the plan for 2-character Chinese terms and 3+ character terms | `EXPLAIN` on the 20-article seed, then a larger seed (carma-benchmark, optional) |
| HP-3 | `proxy.ts` | Runs on every page request | Check the matcher and that the nonce is random per request | Header tests |

## 10. Telemetry starting points

Existing `mss_search_duration_seconds` by kind already separates `nonlatin_sub`. Add: count of CSP violation reports only if report-only is chosen (not recommended). No new alert.

## 11. Principle alignment

| Principle | How served | Cost |
| --- | --- | --- |
| P3 | Quoted and wildcard CJK/Arabic terms stop missing | Extra matches inside longer words |
| P5 | Mode chosen by script, never by language label or quote | Mixed-script terms follow the non-Latin rule |
| P7 | Echo and notes say how a term was matched | Echo wording for non-Latin quoted terms needs a small change |
| P2 | No new moving parts beyond a proxy file | Enforcement can blank a page if a nonce is missed (FP-5) |

## 12. Downstream handoff

- **carma-searchability**: applies to C1 and C3 (match rules per script, golden cases, echo wording).
- **carma-data-sanity**: applies to C2 (CSP is part of the XSS layers) and to the search term handling; short.
- **carma-dba**: only if D1 leads to an index change; the recommended option adds none.
- **carma-telemetry**, **carma-ux**: small; UX applies if D3 option 1 puts the NOT note in the search page.
- **carma-devops**: not needed (no new component or setting).
- **carma-backend-testing**: applies (FP-1, FP-2, FP-4, FP-7).
- **carma-plan**: last, one short phase.
- **carma-benchmark / carma-review**: HP-2 deserves a benchmark if the corpus grows; review the classifier branch order for readability.

## 13. Open questions and assumptions

- The duplicate ADR number 0036 should be resolved by a note, not a renumber; propose an ADR in the next free number that references both by file name. `UNCONFIRMED`.
- Summaries are assumed English, so non-Latin terms against summaries rarely match (ADR-0035, unchanged).
- Hiragana, Katakana and Hangul are assumed to be covered by the Latin-script test (they are not Latin); not run.
- The end-to-end behaviour through the API is `UNCONFIRMED` until the stack runs.

## Decisions recorded

- D1: ADR-0038 (script-first substring).
- D2: ADR-0039 (nonce CSP via proxy.ts).
- D3: ADR-0040 (keep NOT original-only, surface it).
- Routing (user choice, sequential): searchability, data-sanity, backend-testing, plan. Skipped by choice: dba, telemetry, devops, ux (D3 UI note is a one-line change, covered in the plan).
