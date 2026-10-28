---
adr: 0035
title: English stemming applies to English originals, translations and summaries; summaries become searchable
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: 0030 (only its implication that every article is stemmed regardless of language); amends 0025 (search documents gain summaries)
---

# ADR-0035: Stemming scope, and summaries become searchable

## Context and problem statement
Search spec 0003 proposed stemming every article with English rules. The user answered that stemming is for English, applied to the translations and summaries of non-English articles, not to foreign-language originals. Asked whether summaries should become searchable, the user said yes; asked about articles with an unknown language label ("und"), the user chose to treat them as English.

## Considered options
1. Stem every article regardless of language label (the architect's default).
2. Stem English originals, all current translations and summaries; leave foreign originals to substring and exact matching (chosen).

## Decision outcome
Chosen option 2.
- **English-stemmed documents:** `articles.search_text` where the language label's primary subtag is `en` or `und`; every current `article_translations.search_text`; every current summary (`derived_values` rows with `field = 'summary'` and `is_current`).
- **Substring (trigram) branch** applies to the same three documents for unquoted Latin terms of 3 or more characters, plus to foreign originals as today.
- **Quoted terms** stay exact on the `simple` vector for original and translation; summaries are matched for quoted terms by exact whole-word comparison on their English vector's `simple` equivalent (see DBA spec 0004 amendment).
- **NOT** still applies to the original text only (ADR-0027); summaries do not exclude.
- Results say which document matched: original, translation, summary, or several.

### Consequences
- Good: no odd English stemming on foreign originals; English summaries make foreign articles findable by English words even before translation completes, if enrichment ran first.
- Bad: new search scope and two more indexes on `derived_values`; a language-conditional partial index on `articles` whose predicate the query must repeat exactly (plan-test risk); summary language is assumed to be English (UNCONFIRMED); articles not yet enriched are not findable through summaries (coverage note).
- Risks: FP-DB1 (predicate or expression mismatch), summary text not passing through the search normaliser, stale summary after a new article version.

### Confirmation
Search spec 0003 golden cases G13 to G17; DBA spec 0004 plan tests P1, P2, P6, P7.
