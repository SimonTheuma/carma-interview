---
adr: 0030
title: Default term search uses an English stemming index
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: 0007 (only the clause that Latin terms always use exact FTS; Arabic and Chinese substring leaves stand), 0005 (only the clause that bare terms are exact)
---

# ADR-0030: Default term search uses an English stemming index

## Context and problem statement
The user searched "startups" and did not find an article containing "startup". A literal substring match (`ILIKE '%startups%'`) cannot find that article, because the text does not contain the longer word. The user asked for substring matching by default and, when shown this, chose English stemming.

## Considered options
1. Literal substring only.
2. Substring plus suffix trimming of the query term (recommended by the architect).
3. English stemming full-text index on original and translated text (chosen).
4. Trigram word-similarity threshold.

## Decision outcome
Chosen option 3. Add an English-stemmed text-search vector (`to_tsvector('english', ...)`, generated and GIN-indexed) on `articles` and on `article_translations`, and match unquoted Latin terms against it, so "startups" finds "startup". Quoted terms stay exact (ADR-0031). Whether literal substring (trigram) also stays as an OR for unquoted terms is left to carma-searchability and is flagged for the user to confirm.

### Consequences
- Good: inflections match without suffix rules in application code; handled by Postgres's English dictionary.
- Bad: new generated column and GIN index on both tables (write cost and storage on the ingest and worker paths); reindex or backfill of existing rows; English-only stemming, so foreign Latin-script originals (French, Spanish) are stemmed by English rules; it is stemming, not true substring, so partial words ("start" inside "startup") are not matched unless literal substring is kept.
- Risks: write throughput at 800 articles/s (HP-1 in search and DBA specs), migration time on existing data, FP-2 (stemmed path missing on one operator or side).

### Confirmation
Golden tests "startups" finds "startup" on original and translation sides; DBA spec sizes the index and migration; benchmark of ingest throughput with the extra index.

## Pros and cons of the options
1. Literal substring: smallest, fails the stated example.
2. Substring plus trim: no migration, English suffix rules in code, approximate.
3. English stemming: correct inflection handling, schema and write cost, English-only.
4. Word similarity: noisy, tuning needed.
