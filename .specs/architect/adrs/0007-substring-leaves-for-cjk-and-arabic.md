---
adr: 0007
title: Substring (trigram) leaves for Chinese and Arabic terms
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../../search/0001-media-signal-service.md
supersedes: null
---

# ADR-0007: Substring leaves for Chinese and Arabic

## Context and problem statement
Chinese has no spaces; Arabic attaches the definite article and other prefixes. In the sample, an exact-token search for `عقارات` misses id 8 (`العقارات`). A missed mention is the costliest failure (P3).

## Considered options
1. Substring match on normalised text for Chinese and Arabic, FTS for other scripts
2. Exact FTS with light Arabic prefix stripping, substring for Chinese only

## Decision outcome
Chosen option 1: recall first. Leaves are chosen per query term by script, not by the stored `language` label (P5).

### Consequences
- Good: no stemmer or dictionary; finds the sample mentions.
- Bad: matches inside longer words (precision cost); indexes help only for terms of 3 or more characters.
- Confirmation: golden tests G8 and G9, `EXPLAIN` on substring leaves.
