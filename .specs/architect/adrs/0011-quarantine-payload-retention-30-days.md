---
adr: 0011
title: Retain the payload of quarantined items for 30 days
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0011: Retain the payload of quarantined items for 30 days

## Context and problem statement
A quarantined item must be replayable after a rule fix (P3), but retaining raw input conflicts with the rule that raw markup is not retained for admitted articles (data-sanity DS1).

## Considered options
1. Keep `payload_text` for quarantined items only, never rendered or searched, NULLed after 30 days (recommended)
2. Keep only hash and reason codes

## Decision outcome
Chosen option 1.

### Consequences
- Good: replay works; completeness preserved.
- Bad: hostile content is stored for 30 days; mitigated by no read grant for `app_read` and no rendering path.
