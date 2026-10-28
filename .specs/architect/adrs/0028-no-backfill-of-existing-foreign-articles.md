---
adr: 0028
title: Translate new articles only; no backfill of existing foreign articles
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0028: Translate new articles only; no backfill of existing foreign articles

## Context and problem statement
Existing foreign articles have no translation job (devops 0003, DBA 0003 section 10).

## Considered options
1. No backfill.
2. Paced backfill by the translate budget.

## Decision outcome
Chosen option 1. Only articles ingested or re-versioned after release get a translation. No backfill CLI is built now.

### Consequences
- Good: no surprise spend, smaller change.
- Bad: older foreign articles stay findable by original terms only; the search page's untranslated note counts them, so the gap is visible (P3), and the number can be large right after release.
