---
adr: 0001
title: Size to the assignment scope, keep a documented path to Carma scale
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0001: Size to the assignment scope, keep a documented path to Carma scale

## Context and problem statement
The home assignment asks for a small service (20 sample articles, an LLM cost case of 50,000 articles a day, 7 to 9 hours, "don't gold-plate"). The shared Carma context assumes 800 articles a second and a 15-minute freshness target from `published_at`. Designing for both literally is impossible in the time budget, and the brief grades decisions and trade-offs, not completeness.

## Decision drivers
- Grading rewards reasoned trade-offs over completeness (PDF, "Don't gold-plate").
- P2, P3 and P5 to P8 should still hold, so the design can grow.
- 800 articles a second would require partitioning, bulk-write tuning and load tests that the brief does not ask for.

## Considered options
1. Assignment scope, Carma-ready: build for 20 articles and the 50K-a-day cost case; keep schema and component boundaries so the 800/s target and the 15-minute SLO are a documented growth path.
2. Full Carma scale now.
3. Assignment scope only, ignoring Carma constraints.

## Decision outcome
Chosen option: "Assignment scope, Carma-ready", because it meets the grading criteria within the time budget while keeping the Carma principles checkable.

### Consequences
- Good: small, finishable plan; a README section can describe the growth path with evidence.
- Good: structure (job ledger, transactional enqueue, append-only enrichments, content hash) is the same shape needed at scale.
- Bad: partitioning, bulk-insert tuning, pgmq/pgvector and the 15-minute SLO measurement are documented but not built.
- Risks: the growth path claims are untested at scale. Mitigation: a quick synthetic benchmark of HP-2, HP-3 and HP-4 on a larger table (optional, carma-benchmark).

### Confirmation
README "Architecture & Decisions" lists what is built, what is stubbed and how it would be finished; plan phases show the cut line.

## Pros and cons of the options
1. Meets the brief and the principles; some claims are untested at scale.
2. Faithful to Carma; blows the time budget and risks gold-plating.
3. Smallest; abandons the shared principles and traceability.
