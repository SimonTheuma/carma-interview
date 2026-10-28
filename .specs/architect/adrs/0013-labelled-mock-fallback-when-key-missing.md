---
adr: 0013
title: Fall back to a labelled mock adapter when a provider key is missing
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0013: Fall back to a labelled mock adapter when a provider key is missing

## Context and problem statement
Graders may run the stack without keys. The user will supply keys for real runs. Devops DV1.

## Considered options
1. `ENRICHMENT_MODE=auto`: each provider independently uses the mock when its key is absent (recommended)
2. Fail fast without both keys

## Decision outcome
Chosen option 1. Mock values carry origin `mock` and the UI shows 'Mock output'. `real` mode remains available and fails fast on a missing key.

### Consequences
- Good: runs anywhere; tests use the same path.
- Bad: someone may mistake mock output for real; mitigated by origin labelling (FP-17, FP-D15).
