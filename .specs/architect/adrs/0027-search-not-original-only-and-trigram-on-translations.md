---
adr: 0027
title: NOT applies to the original text only, and translations get a trigram index
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0027: NOT applies to the original text only, and translations get a trigram index

## Context and problem statement
Search spec 0002 defaulted NOT to exclude on either side and DBA 0003 skipped a trigram index on translations. The user chose the other options.

## Considered options
1. NOT excludes on either side, no trigram on translations.
2. NOT original-side only, trigram on translations.

## Decision outcome
Chosen option 2. A NOT term excludes an article only if the original text matches it. Translations get a partial GIN trigram index on `search_text`, so substring leaves (non-Latin terms, such as brand names left untranslated inside an English translation) also search translations. Positive terms match either side.

### Consequences
- Good: NOT cannot hide an article because of a machine-translation artefact; names kept in their own script are searchable in the translation.
- Bad: about +4.5 KB per translation (about 9.5 KB total per translation, DBA 0003 section 3); a trigram insert cost in the worker; the NOT rule differs between sides and the search echo must say so.
- Note: the current leaf classifier sends only non-Latin terms to the substring path, so the index mainly serves those. Latin partial-word search over translations would need a classifier change and is not decided.
