---
adr: 0026
title: Show the English headline on every translated foreign search card
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0026: Show the English headline on every translated foreign search card

## Context and problem statement
UX spec 0003 left open whether search cards show the English headline only for translation matches or for all foreign cards.

## Considered options
1. All foreign cards that have a translation.
2. Only translation matches.

## Decision outcome
Chosen option 1. A muted "English: <headline>" line under the original headline on every foreign card with a current translation, rendered as text with `lang="en"`. Extends the display scope of ADR-0024/0025 (cards were original-only apart from the match marker).

### Consequences
- Good: foreign articles can be scanned in English.
- Bad: one more line per card; the search query must return `headline_en` for every foreign row.
