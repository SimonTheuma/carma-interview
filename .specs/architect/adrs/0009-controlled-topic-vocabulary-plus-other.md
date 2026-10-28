---
adr: 0009
title: Controlled topic vocabulary plus Other
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0009: Controlled topic vocabulary plus Other

## Context and problem statement
Each article gets 1 to 3 topics. Free-form tags make the topic filter and chart noisy and enlarge the prompt-injection surface (architect decision D4).

## Considered options
1. Controlled list of about 20 topics plus `Other` (recommended)
2. Free-form tags, normalised

## Decision outcome
Chosen option 1. The list is versioned data (`vocab_version` on each topic value); the structured-output schema uses it as an enum.

### Consequences
- Good: stable filters and chart series; injected text cannot invent tags.
- Bad: edge topics fall into `Other`; the list must be written (plan task).
