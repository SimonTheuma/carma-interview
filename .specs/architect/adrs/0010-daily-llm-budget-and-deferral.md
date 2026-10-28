---
adr: 0010
title: Daily LLM budget per provider; at the limit jobs are deferred, never dropped
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0010: Daily LLM budget per provider; at the limit jobs are deferred, never dropped

## Context and problem statement
The brief asks for a cost guardrail. Carma puts completeness above speed and cost (P3). Architect D7 and data-sanity DS2.

## Considered options
1. Per-provider daily cap in configured currency; jobs wait in `deferred_budget` until the next UTC day (recommended)
2. Hard-fail jobs at the limit
3. No cap

## Decision outcome
Chosen option 1. Cap values come from configuration (small placeholders until prices are known); reservation is a single atomic SQL statement (DBA section 4.3).

### Consequences
- Good: bounded spend; nothing lost; visible state and banner.
- Bad: enrichment lags on busy days; real-mode start requires provider prices to be configured.
