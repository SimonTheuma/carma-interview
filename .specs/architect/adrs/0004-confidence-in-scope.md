---
adr: 0004
title: Store and show confidence on every derived field
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0004: Confidence is stored and shown

## Context and problem statement
Carma requires confidence on sentiment, topic and summary (P6, P7). The brief does not ask for it.

## Considered options
1. Store and show confidence with origin and range
2. Omit and document as growth path

## Decision outcome
Chosen option 1. Each derived value stores normalised 0 to 100, raw value, min/max range, origin and method version. Missing confidence is shown as "no confidence available", never a default. Self-reported LLM numbers are labelled as such.

### Consequences
- Good: P6 to P8 satisfied; strong README story.
- Bad: extra columns and UI; confidence from jev is a concentration measure, so the tooltip must explain it.
