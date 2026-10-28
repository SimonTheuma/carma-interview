---
adr: 0039
title: Enforce a nonce-based script CSP from proxy.ts
status: accepted
date: 2026-10-28
decision-makers: [simon@mavericks.mt]
raw-spec: ../0005-search-and-csp-hardening.md
supersedes: null
---

# ADR-0039: Enforce a nonce-based script CSP from proxy.ts

## Context and problem statement
`next.config.ts` allows `'unsafe-inline'` for scripts, so the CSP would not stop an injected inline script. React text escaping is the primary XSS control; the CSP is defence in depth. All pages are `force-dynamic`, so per-request nonces work (Next.js 16 CSP guide).

## Considered options
1. Enforce a nonce for scripts, keep `style-src-attr 'unsafe-inline'` (chosen).
2. Report-only first.
3. Keep and document.

## Decision outcome
Chosen option 1. Add `src/proxy.ts` that sets the CSP per request: `script-src 'self' 'nonce-…' 'strict-dynamic'` (`'unsafe-eval'` in development only), `style-src 'self'`, `style-src-attr 'unsafe-inline'` for five inline style attributes, and the existing other directives. Remove the CSP from `next.config.ts`; keep the other headers there. Exclude static assets and `/api` from the matcher.

### Consequences
- Good: injected inline scripts do not run.
- Bad: a missing nonce blanks a page; styles via attributes stay relaxed.
- Risks: FP-4, FP-5, FP-6.

### Confirmation
Header tests per route class; browser run of every page with no console CSP errors.
