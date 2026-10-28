---
spec: carma-data-sanity
number: 0004
title: Substring-term handling and nonce CSP (delta)
status: draft
date: 2026-10-28
feature: search-and-csp-hardening
inputs: [.specs/architect/0005-search-and-csp-hardening.md, .specs/search/0004-search-and-csp-hardening.md, .specs/architect/adrs/0038-script-first-substring-for-non-latin-terms.md, .specs/architect/adrs/0039-nonce-based-csp-via-proxy.md, .specs/data/sanitization/0001-media-signal-service.md]
principles: [P2, P3, P5]
supersedes: null
---

# 0004 Substring-term handling and nonce CSP

## 1. Summary
Delta to sanitisation specs 0001-0003. Two consumers change: the search query builder (more terms now reach `ILIKE`) and the browser (CSP becomes nonce-based). Ingest validation, null handling for articles, prompt-injection controls and cost controls are unchanged. Decisions are ADR-0038 and ADR-0039; not reopened.

## 2. Trust boundaries (changed consumers only)
User query text -> `scan` -> `parse` (limits) -> `classifyLeaf` -> `normaliseText` -> bound parameter -> `ILIKE ... ESCAPE '\'` ([compile.ts:141-143](../../../src/lib/search/compile.ts), [leaf.ts:68-73](../../../src/lib/search/leaf.ts)). Article text -> React text node -> browser, under the CSP from `src/proxy.ts`.

## 3. Query terms into `ILIKE`
Already safe, kept:
- The value is a bind parameter, never SQL text. `escapeIlike` escapes backslash, `%` and `_` ([leaf.ts:68-70](../../../src/lib/search/leaf.ts)); order is normalise, then escape.
- Bidi controls, zero-width characters, harakat and tatweel are removed by `normaliseText` at query time, the same as at index time ([normalise/index.ts:3-9](../../../src/lib/normalise/index.ts)), so a hidden-character term cannot dodge matching or inject direction changes into the echo note.
- Cost bounds: at most 500 characters, 20 leaves, 8 nesting levels ([parse.ts:19-23](../../../src/lib/search/parse.ts)); `app_read` has a 2 second statement timeout ([0001_init.sql:250](../../../db/migrations/0001_init.sql)), mapped to a 503 note ([run.ts:176-183](../../../src/lib/search/run.ts)). Worst case is 20 substring leaves x 3 documents = 60 `ILIKE` predicates per row, bounded by the timeout, not by design.

Delta (new risk from ADR-0038):
- **FP-D1 empty term after normalisation.** A term made only of characters that normalisation removes can still be classified non-Latin (tatweel U+0640 is a letter modifier outside Latin script) and then becomes `%%`, which matches every row. Rule: after `normaliseLeafTerm`, an empty result is a parse error `empty_term` ("That term has no searchable characters"), not a match-all. Applies to bare, quoted and wildcard forms. Not run; reasoned from the code.
- **FP-D2 short substring terms** (1-2 characters) scan the filtered set (search spec 0004 section 5). Accepted; the timeout is the control. No minimum length (P3).
- **FP-D3 phrase spacing.** Collapse whitespace in non-Latin phrases before matching (search spec 0004). Not a security issue; listed because it is applied at the same place.
- Tighter caps for substring leaves are not needed at the assignment scale. `UNCONFIRMED`: if the corpus grows, cap substring leaves per query (for example 5) as a measured follow-up.

## 4. CSP as an XSS layer
Layers, in order of strength: (1) markup reduced to text at ingest with the removal recorded ([reduce.ts](../../../src/lib/sanitise/reduce.ts)); (2) React renders article text as text only, and `dangerouslySetInnerHTML`, `innerHTML` and `eval` do not appear in `src` ([TextBlock.tsx](../../../src/components/TextBlock.tsx)); (3) CSP stops an injected inline script from running if (1) and (2) ever fail.

Header set per request by `src/proxy.ts`:
```
default-src 'self';
script-src 'self' 'nonce-<N>' 'strict-dynamic'   (+ 'unsafe-eval' only when NODE_ENV=development);
style-src 'self' 'nonce-<N>';
style-src-attr 'unsafe-inline';
img-src 'self' data:; connect-src 'self'; object-src 'none';
frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```
- Nonce: 16 or more random bytes from the platform CSPRNG (`crypto.randomUUID()` or `crypto.getRandomValues`), base64, new for every request, never reused or logged. Also passed as the `x-nonce` request header so Next.js applies it to its own scripts and styles.
- Matcher: pages only. Exclude `/api/*`, `/_next/static`, `/_next/image` and the favicon. API JSON responses keep `X-Content-Type-Options: nosniff` from `next.config.ts`.
- `next.config.ts` keeps `X-Content-Type-Options`, `Referrer-Policy` and `X-Frame-Options`, and loses its `Content-Security-Policy` entry so there is exactly one CSP per response (two CSPs intersect and hide mistakes).
- Residual risk: `style-src-attr 'unsafe-inline'` allows inline `style=""` attributes (five uses, all with numbers or fixed colours). It does not allow script. Injecting markup is already prevented by layers 1 and 2; the remaining exposure is limited CSS-based data probing, judged low for a read-only, unauthenticated internal tool. Removing it means replacing the five attributes with classes or CSS variables set from a nonce-bearing style; deferred.
- `'strict-dynamic'` makes browsers ignore `'self'` for scripts; scripts loaded by trusted, nonce-bearing scripts still run. Older browsers without CSP3 fall back to `'self'` and the nonce.
- Development: `'unsafe-eval'` is allowed only when `NODE_ENV` is `development`; production must not contain it (test below).

## 5. Must not regress (sample articles 6 and 18)
Script injection in headlines or bodies stays inert: the stored text is reduced, rendered as text, and the CSP does not allow inline script. Existing sanitiser and render tests ([sanitise.test.ts](../../../tests/unit/sanitise.test.ts)) stay; add the checks in section 6.

## 6. Test inputs (for carma-backend-testing)
- Query terms: `%`, `_`, `\`, `"%_\"`, tatweel only (`ـ`), zero-width only, bidi control inside a Chinese word, 500-character term, 20 short Chinese terms joined with OR (must finish or return the timeout note), mixed `iPhone苹果`.
- Header test on `proxy()`: two requests give different nonces; `script-src` has the nonce and `'strict-dynamic'`, has no `'unsafe-inline'`, has no `'unsafe-eval'` when `NODE_ENV=production`; matcher excludes `/api/search` and `/_next/static/x.js`; exactly one CSP header on a page response.
- Page test: fetch each page's HTML; every `<script>` without `src` carries the response nonce; none uses an inline event-handler attribute.
- Browser run (e2e): load `/`, `/trends`, `/status`, `/upload`, an article page for sample 6 and for sample 18; console shows no CSP violation; progress bars and chart swatches keep their colours.

## 7. Telemetry
No new metric. `mss_search_timeouts_total` already counts the cost-bound case; add a count of `empty_term` parse errors only if the existing parse-error counter has no reason label.

## 8. Risks and hot paths
| ID | Item | Control |
| --- | --- | --- |
| FP-D1 | Empty-after-normalisation term matches everything | `empty_term` parse error |
| FP-D4 | Missing nonce blanks a page | Browser run in section 6 |
| FP-D5 | Two CSP headers (config and proxy) | Remove from config; header test |
| HP-D1 | `proxy.ts` on every page request | Keep it to nonce generation and header assembly; no I/O |

## 9. Decisions needed and open questions
- None blocking. `UNCONFIRMED`: the `empty_term` rule (FP-D1) is a default for the implementation, not a user decision.
- Whether to drop `style-src-attr 'unsafe-inline'` later is a follow-up, not scheduled.
