---
spec: carma-backend-testing
number: 0005
title: Test plan for non-Latin search terms, NOT visibility and nonce CSP (delta)
status: draft
date: 2026-10-28
feature: search-and-csp-hardening
inputs: [.specs/architect/0005-search-and-csp-hardening.md, .specs/search/0004-search-and-csp-hardening.md, .specs/data/sanitization/0004-search-and-csp-hardening.md, .specs/architect/adrs/0038-script-first-substring-for-non-latin-terms.md, .specs/architect/adrs/0039-nonce-based-csp-via-proxy.md, .specs/architect/adrs/0040-keep-not-original-only-and-surface-it.md, .specs/testing/backend/0004-english-first-substring-search.md]
principles: [P2, P3, P5]
supersedes: null
---

# 0005 Test plan: search-and-csp-hardening

## 1. Summary and scope
Delta to testing specs 0001-0004. No new pipeline stage, queue or dependency, so conservation, idempotency, resilience, fault injection, load and soak plans do not apply and are not repeated. This plan covers: the classifier and compiler change (ADR-0038), the NOT note (ADR-0040), the CSP proxy (ADR-0039) and the regressions they could cause. Optional extra: one `EXPLAIN` note for short substring terms.

## 2. Environment and tooling (current state)
- Runner: Vitest for `tests/unit` and `tests/integration` ([vitest.config.ts](../../../vitest.config.ts)); Playwright for `tests/e2e` against `BASE_URL` (default `http://127.0.0.1:3000`, [playwright.config.ts](../../../playwright.config.ts)).
- Integration harness with a real PostgreSQL: [tests/harness/db.ts](../../../tests/harness/db.ts); article insert helper pattern in [search-default-match.test.ts](../../../tests/integration/search-default-match.test.ts).
- No addition needed. For the proxy unit test, import the exported `proxy` function and call it with a `NextRequest`; no server needed.

## 3. Tests by level

### Unit (every commit)
| ID | File (new or extended) | Checks |
| --- | --- | --- |
| U1 | `tests/unit/search-classify-script.test.ts` | Table over scripts for bare, quoted single, quoted multi-word, and `*` forms: Han, Hiragana, Katakana, Hangul, Arabic, Hebrew, Cyrillic, Greek, Devanagari, Thai -> `substring`; Latin, accented Latin (`café`), digits (`2026`) -> exact/phrase/wildcard as before; mixed (`iPhone苹果`) -> `substring`; symbols (`$AAPL`, `€`, emoji) -> Latin rules |
| U2 | same file | Regression of Latin cases from search spec 0003 (`"startup"` exact, `startup*` wildcard, `"oil prices"` phrase) |
| U3 | `tests/unit/parse.test.ts` (extend) | `empty_term` error for tatweel-only, zero-width-only, bidi-control-only terms, bare, quoted and starred; normal terms unaffected |
| U4 | `tests/unit/search-compile-nonlatin.test.ts` | Compile output for `"人工智能"`, `科技*`, `"人工智能和云计算"`, `عقارات`: uses `ILIKE ... ESCAPE`, bound parameter is `%term%` with `%`, `_`, `\` escaped; every `$n` is referenced (class check from review 0005); phrase whitespace collapsed |
| U5 | `tests/unit/search-notes.test.ts` | Non-Latin note appears iff at least one leaf is `substring` (not merely a non-Latin character in the raw query); NOT note appears iff the AST has `and_not` (not for a word `NOT` inside quotes) |
| U6 | `tests/unit/csp-proxy.test.ts` | Two calls give different nonces of at least 16 bytes; `script-src` contains `'nonce-…'` and `'strict-dynamic'`; no `'unsafe-inline'` in `script-src`; no `'unsafe-eval'` when `NODE_ENV=production` and present in development; `style-src-attr 'unsafe-inline'` present; `x-nonce` request header set; exactly one `Content-Security-Policy` header; matcher excludes `/api/search`, `/_next/static/x.js`, `/favicon.ico` and includes `/` and `/trends` |
| U7 | `tests/unit/next-config-headers.test.ts` | `next.config.ts` headers contain `nosniff`, `Referrer-Policy`, `X-Frame-Options` and no CSP entry |

### Integration, real PostgreSQL (every commit if the database is available, otherwise nightly)
| ID | File | Checks |
| --- | --- | --- |
| I1 | `tests/integration/search-nonlatin.test.ts` | Load fixtures with the real text of sample articles 8 and 9. G18-G23: `"人工智能"`, `人工智能`, `科技*`, `"人工智能和云计算"`, `"عقارات"`, `عقارات*` each return the expected article; `"人工智能 云计算"` returns none (G21 negative) |
| I2 | same | G24 regression: `"oil prices"`, `renew*`, `"startup"` unchanged |
| I3 | same | G25: `"能源" AND NOT 中国` excludes article 9 by original text |
| I4 | same | G26: a foreign article whose English translation (not the original) contains `coal`: `energy AND NOT coal` still returns it, and `echo_notes` contains the NOT note |
| I5 | same | Escapes: `%`, `_`, `\` as terms match only literal occurrences; a tatweel-only query returns 400 `empty_term`, not all rows (FP-D1) |
| I6 | same | 20 short Chinese terms joined with OR return results or the 503 timeout note within the statement timeout; never a 500 |
| I7 | `tests/integration/search-plans.test.ts` (extend, optional) | `EXPLAIN` for a 3-character Chinese term shows the trigram index on the 20-article seed or a scan that completes; record the plan for a 2-character term as information, no pass/fail (HP-S1) |

### End to end, browser (nightly and before release; needs the stack up)
| ID | File | Checks |
| --- | --- | --- |
| E1 | `tests/e2e/csp.spec.ts` | Visit `/`, `/trends`, `/status`, `/upload` and the article pages for sample articles 6 and 18; assert no `securitypolicyviolation` events and no CSP console errors; response has one CSP header with a nonce; every inline `<script>` carries that nonce |
| E2 | same | Sample articles 6 and 18: injected script text is visible as text and nothing executes (a `window.__pwned` flag set by the payload stays undefined) |
| E3 | same | Visual spot check by assertion: progress bar on `/status` and chart swatches on `/trends` have a non-empty computed width/background (inline style attributes still work) |
| E4 | `tests/e2e/smoke.spec.ts` (extend) | Search `"人工智能"` in the UI returns article 9 and shows the non-Latin note; search with `AND NOT` shows the NOT note directly under "Interpreted as" |
| E5 | `scripts/smoke.sh` (extend) | `curl -sI` of `/` shows one CSP header with `nonce-` and no `unsafe-inline` in `script-src`; `/api/healthz` has no CSP |

## 4. Failure-point traceability
| FP | Source | Tests |
| --- | --- | --- |
| FP-1 / FP-S1 script misclassification (symbols, mixed, digits) | architect 0005, search 0004 | U1, U2, I2 |
| FP-2 / FP-S2 phrase spacing and normalisation mismatch | architect 0005, search 0004 | U4, I1 (G21 positive and negative) |
| FP-3 / HP-S1 short terms scan | architect 0005, search 0004 | I6, I7 |
| FP-4 / FP-D5 matcher or double CSP | architect 0005, sanitisation 0004 | U6, U7, E5 |
| FP-5 / FP-D4 missing nonce blanks a page | architect 0005, sanitisation 0004 | E1 |
| FP-6 inline styles blocked | architect 0005 | E3 |
| FP-7 NOT surprises | architect 0005 | I3, I4, U5, E4 |
| FP-S3 note trigger | search 0004 | U5 |
| FP-D1 empty term matches everything | sanitisation 0004 | U3, I5 |
| FP-D2 / FP-D3 short terms, phrase spacing | sanitisation 0004 | I6, U4 |
| XSS regression, articles 6 and 18 | sanitisation 0004 section 5 | existing [sanitise.test.ts](../../../tests/unit/sanitise.test.ts), E2 |
| HP-1 classifier branch order | architect 0005 | U1 |
| HP-3 / HP-D1 proxy cost | architect 0005 | U6 (no I/O, no await in the proxy body, asserted by a synchronous call) |

No FP is left without a test.

## 5. Soft requirements and load
None added. No freshness, throughput or resilience claim changes. Optional: one `EXPLAIN` reading (I7) and, only if the corpus is raised above the 20-article sample, a timing of 2-character substring terms with carma-benchmark.

## 6. How to run
```bash
npm test                      # unit + integration (U*, I*)
npm run typecheck
npx vitest run tests/unit/csp-proxy.test.ts
docker compose up -d --build --wait
npx playwright test tests/e2e/csp.spec.ts
sh scripts/smoke.sh
```

## 7. Exit criteria
- U1-U7 and I1-I6 pass; I7 plan recorded (information only).
- E1-E5 pass against a fresh `docker compose up`, with the browser console free of CSP violations on all pages.
- Sample articles 6 and 18 remain inert (E2 and the existing sanitiser tests).
- Failure of E1 or E3 blocks enabling the enforced CSP; fallback is to ship the previous header (ADR-0039 option 3) and record that in the README. Failure of I1-I5 blocks the classifier change. Both are blockers for this feature, not risks to accept.

## 8. Gaps, risks and open questions
- Integration tests need a database; if unavailable in CI they run nightly (as for plan 0004).
- E1 cannot prove a hostile inline script is blocked in every browser; it proves the header and nonce wiring. A direct block test (inject a script element without a nonce through the page and assert a violation event) is a nice-to-have, not required.
- Language coverage is limited to the sample articles (Arabic, Chinese); Hebrew, Cyrillic, Greek, Devanagari, Hangul and Kana are covered by the classifier table only (U1), not by stored text.
- `UNCONFIRMED`: the symbol rule (`\p{S}` excluded from the non-Latin test) is encoded in U1; if the implementation keeps the current rule, U1's symbol rows change.

## 9. Handoff to carma-plan
Order: U1-U5 and the classifier change first (smallest, no stack needed); then I1-I6; then the `proxy.ts` change with U6, U7; then E1-E5 on the running stack; README note for NOT and the CSP last.
