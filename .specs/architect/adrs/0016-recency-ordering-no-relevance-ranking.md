---
adr: 0016
title: Results ordered by recency; no relevance ranking in this build
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0016: Results ordered by recency; no relevance ranking in this build

## Context and problem statement
The brief requires keyset pagination; a relevance-ordered keyset needs a stable rank and a rank-and-id cursor (search decision S3).

## Considered options
1. Recency only, `(published_at DESC, id DESC)` (recommended)
2. Relevance ordering with a rank cursor

## Decision outcome
Chosen option 1. Growth path: `ts_rank_cd` with a `(rank, id)` cursor, shown as an uncalibrated score.

### Consequences
- Good: simple, fast, matches the brief.
- Bad: the best match may not be first.
