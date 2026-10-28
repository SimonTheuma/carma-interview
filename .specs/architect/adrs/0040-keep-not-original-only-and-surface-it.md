---
adr: 0040
title: Keep NOT as original-text only and show the rule beside the query
status: accepted
date: 2026-10-28
decision-makers: [simon@mavericks.mt]
raw-spec: ../0005-search-and-csp-hardening.md
supersedes: null
---

# ADR-0040: Keep NOT as original-text only and show the rule beside the query

## Context and problem statement
ADR-0027 makes `AND NOT term` exclude by original text only, while positive terms also match translations and summaries. A foreign article whose English translation contains the excluded word is still returned. Review 0006 (C3) asked whether to keep this.

## Considered options
1. Keep ADR-0027 and surface the rule (chosen).
2. Exclude on original and translation.
3. Exclude on any side.
4. Per-query switch.

## Decision outcome
Chosen option 1. ADR-0027 stands. The note "NOT terms exclude articles by their original text only" is shown beside the query in the search UI whenever the query has a NOT, and stated in the README search section. The error direction is extra results, never lost ones (P3).

### Consequences
- Good: no machine-translation artefact can hide an article; no new grammar.
- Bad: some foreign articles appear that a reader expects excluded.
- Risks: FP-7.

### Confirmation
Golden test with a translated article containing the excluded word; UI test that the note is visible.
