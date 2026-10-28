---
adr: 0033
title: Unquoted Latin terms match by English stem OR literal substring
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: null
---

# ADR-0033: Unquoted Latin terms match by English stem OR literal substring

## Context and problem statement
ADR-0030 chose English stemming. The user's original request also asked for substring matching by default. Search spec 0003 asked whether to keep the literal substring branch as well.

## Considered options
1. Stem only.
2. Stem OR literal substring (chosen).

## Decision outcome
Chosen option 2, for unquoted Latin terms of 3 or more characters, on original and current translation. Terms of 1-2 characters use the stem only. Quoted terms stay exact (ADR-0031). Arabic, Chinese and Japanese terms keep substring (ADR-0007).

### Consequences
- Good: "startups" finds "startup" and "start" finds "startup"; reuses the existing trigram indexes.
- Bad: more false positives; up to four predicates per term (plan risk HP-S1).
- Risks: FP-S10 (over-matching), HP-S1.

### Confirmation
Search spec 0003 section 12 golden cases 1 to 4 and 8.
