---
adr: 0032
title: English first on cards and article page, original underneath
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: 0026 (English headline becomes the primary line instead of a muted second line), 0024 and 0025 display clauses (article page swap becomes reveal-below)
---

# ADR-0032: English first on cards and article page, original underneath

## Context and problem statement
Cards showed the original headline first with an English line beneath (ADR-0026). The article page defaults to the translation, but its control swaps translated and original. The user wants English by default, the original underneath, and for foreign articles the full text to show the English version first with an option to show the original underneath it.

## Considered options
1. Headline pair only on cards; excerpt stays original.
2. Headline pair and English excerpt on cards; article page reveals the original below the English text (chosen).

## Decision outcome
Chosen option 2.
- Foreign article with a current translation: English headline is the primary line, the original headline is underneath (muted, labelled with the language).
- Search card "Show more": English excerpt first; a control reveals the original excerpt underneath it. The search query adds an English excerpt (from the current translation).
- Article page: translated text first; a control reveals the original text underneath, with the translation staying visible.
- Foreign article with no translation yet: original is the primary line with an "English translation pending" note (stated in the question the user answered; carma-ux may refine the wording).
- English-original articles are unchanged.

### Consequences
- Good: scanning in English; original stays one control away (P8).
- Bad: the search query returns a second excerpt; layout grows when the original is revealed.
- Risks: FP-6 (stale translation), FP-7 (blank primary line), FP-9 (reveal control not reachable).

### Confirmation
Component tests for each state; version test; keyboard and no-JS checks.
