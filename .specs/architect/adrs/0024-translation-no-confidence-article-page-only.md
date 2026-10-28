---
adr: 0024
title: Translations carry no confidence and show on the article page only
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0024: Translations carry no confidence and show on the article page only

> Partly superseded by ADR-0025: search now matches translated text too. The no-confidence decision and the article-page display stand.

## Context and problem statement
Decide confidence and display scope (architect 0003, D4/D5). Principles P6, P7.

## Considered options
1. No confidence, article page. 2. No confidence, also list/search headlines. 3. Self-reported confidence.

## Decision outcome
Chosen option 1: labelled 'Machine translated, no confidence available'; original one click away. List and search views stay original-language for now.

### Consequences
- Good: no weak number presented as evidence; small scope.
- Bad: no quality signal for the reader; searching in English across languages is not covered.
