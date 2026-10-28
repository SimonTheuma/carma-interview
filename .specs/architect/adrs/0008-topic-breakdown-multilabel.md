---
adr: 0008
title: Topic breakdown counts an article under each of its topics
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../../search/0001-media-signal-service.md
supersedes: null
---

# ADR-0008: Multi-label topic breakdown

## Context and problem statement
Each article has 1 to 3 topics. A chart split by topic must say how multi-topic articles are counted.

## Considered options
1. Multi-label: counted under each topic; the response sets `multi_label: true` and the UI says so
2. Primary topic only

## Decision outcome
Chosen option 1 (P3, P10). Series may sum above the total; the total is always the count of distinct articles in scope.

### Consequences
- Good: no topic is hidden.
- Bad: the sum-of-bars conservation test does not apply to `group_by=topic`; the UI must label it.
