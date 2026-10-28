---
adr: 0031
title: Double quotes mark an exact match, and the echo shows exact terms in quotes
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: null
---

# ADR-0031: Double quotes mark an exact match, and the echo shows exact terms in quotes

## Context and problem statement
With broader matching on by default (ADR-0030), users need a way back to precision. The user said exact matches should be rendered within quotes.

## Considered options
1. Quotes are the exact syntax; the parsed-query echo shows exact terms in quotes and other terms without (chosen).
2. Option 1 plus a per-result label of how each term matched.

## Decision outcome
Chosen option 1. A term in double quotes matches whole words (a multi-word quoted term is a phrase), as phrases already do. Unquoted terms use the default broader match. The echo (`src/lib/search/echo.ts`) renders exact terms inside quotes. Per-result match labels are not built now.

### Consequences
- Good: no new grammar; precision path exists; user sees what was matched (P7).
- Bad: users must know the quote syntax; the UI should hint at it.
- Risks: FP-8 (quoted term accidentally broadened).

### Confirmation
Test: `"startup"` does not match "startups"; echo test.
