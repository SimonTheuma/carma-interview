---
adr: 0025
title: Search matches both the original and the translated text
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: 0024 (only the clause "list and search views stay original-language"; the no-confidence decision stands)
---

# ADR-0025: Search matches both the original and the translated text

## Context and problem statement
ADR-0024 kept search on the original text only. The user then asked that search work on both the translated and the original text, so a reader can look for original terms or for English terms (P3, P5).

## Considered options
1. Separate search columns on `article_translations`, queried alongside the original (recommended).
2. Append translated text to `articles.search_text`: changes the system-of-record row, forces re-indexing of `articles`, mixes provenance, and breaks when a translation is superseded.
3. Translate the query into each language: guessy, misses terms, cost per query.

## Decision outcome
Chosen option 1. `article_translations` carries its own `search_text` (same normaliser and `search_text_ver` as `articles`), a generated `search_vector`, and a trigram index for the substring path. A term matches an article if it matches the original OR the current translation. Results say which side matched. Articles are matched only once a translation exists: until then an English query will not find a foreign article, and the UI says translation is pending (P3). Display scope otherwise unchanged: translated text is shown on the article page; list cards stay original with a "matched in translation" marker.

### Consequences
- Good: original is untouched; either side is findable; translation can be rebuilt or superseded without touching `articles`.
- Bad: a second GIN and trigram index to maintain on every translation insert; query plans have an OR across two relations; machine-translated matches may be wrong, so they are labelled.
- Risks: FP-S1 (query ignores translations), FP-S2 (stale translation matches after a new version). See search spec 0002.
