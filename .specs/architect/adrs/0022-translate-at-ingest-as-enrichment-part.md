---
adr: 0022
title: Translate non-English articles at ingest as a third enrichment part
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0022: Translate non-English articles at ingest as a third enrichment part

## Context and problem statement
Foreign-language articles need an English full text shown by default (architect 0003, D1). Principles P3, P1.

## Considered options
1. At ingest via the existing job queue. 2. Lazy on first view. 3. Hybrid.

## Decision outcome
Chosen option 1: a `translation` part queued in the ingest transaction when language is not English; unknown language is queued, not skipped.

### Consequences
- Good: reader never waits; reuses claim, budget, breaker, retry.
- Bad: spend on articles nobody opens; one extra insert on the ingest hot path (HP-1, benchmark it).
