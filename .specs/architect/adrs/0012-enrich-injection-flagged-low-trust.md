---
adr: 0012
title: Enrich injection-flagged articles and mark their derived values low-trust
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0012: Enrich injection-flagged articles and mark their derived values low-trust

## Context and problem statement
Articles with instruction-like text aimed at models are a signal, not a reason to drop (P3). Data-sanity DS4.

## Considered options
1. Enrich anyway; set `prompt_injection_suspected` and `trust = low`; show a marker (recommended)
2. Skip enrichment for flagged articles

## Decision outcome
Chosen option 1.

### Consequences
- Good: still counted and summarised; transparent.
- Bad: small risk that a manipulated value is shown; mitigated by validators, fences and the marker.
