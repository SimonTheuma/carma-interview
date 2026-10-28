---
adr: 0006
title: Core PostgreSQL plus contrib extensions (pg_trgm, unaccent, pg_stat_statements)
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0006: Extension package

## Context and problem statement
Substring search for Chinese and Arabic needs trigram indexing; performance reasoning needs query statistics. Extended packages (queue, vector, CJK segmentation) are out of proportion to the brief.

## Considered options
1. Core + contrib: `pg_trgm`, `unaccent`, `pg_stat_statements`
2. Core only
3. Extended (pgmq, pgvector, pg_bigm/PGroonga)

## Decision outcome
Chosen option 1. Availability on the chosen image and the behaviour of `pg_trgm` on non-ASCII text are to be verified at build (search spec FP-S2). Fallback: option 2, substring leaves unindexed.

### Consequences
- Good: small operational surface; ships in the official image.
- Bad: two-character Chinese terms give no usable trigrams, so those queries may scan (correct, slower). Growth path: `pg_bigm` or PGroonga.
