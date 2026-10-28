---
adr: 0036
title: Bare terms are exact again; stemming applies only to terms ending in *
status: accepted
date: 2026-10-28
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: 0030 (default stemming), 0033 (stem OR substring by default), 0031 (quotes as the only exact syntax; the loose-match note and quote tip); amends 0035 (stemming scope now applies to wildcard terms; summary search stays)
---

# ADR-0036: Bare terms are exact again; stemming applies only to terms ending in *

## Context and problem statement
The requirements fix the query language: AND, OR, AND NOT; nested brackets; phrases in double quotes; a `*` wildcard (`renew*` matches "renewable", "renewables"); and case-sensitive keywords (lowercase "and" is a search term). ADR-0030 and ADR-0033 had made English stemming and substring matching the default for every bare term, which made the wildcard redundant and the meaning of a bare word unpredictable. Nothing has been built yet, so this is a change of design, not a revert of code.

## Considered options
1. `*` means prefix OR English stem; bare words are exact whole-word matches (chosen).
2. `*` means prefix only; drop the English index.

## Decision outcome
Chosen option 1.
- **Bare term** (`startups`): exact whole word, case-folded, on the `simple` vector, as before this feature. It matches "startups" and not "startup".
- **Quoted term or phrase** (`"media intelligence"`): phrase match on the `simple` vector, unchanged.
- **Wildcard** (`renew*`): matches words that start with the text (prefix on the `simple` vector) OR share its English stem (the English expression index of ADR-0034), on original, translation and summary. Prefix must be at least 2 characters and `*` goes at the end of one word (existing rules, ADR-0005).
- **No literal-substring branch for Latin text.** Arabic, Chinese and Japanese terms keep their substring matching (ADR-0007) because those scripts have no word boundaries.
- **Keywords:** `AND`, `OR`, `AND NOT` are case-sensitive; lowercase `and`, `or`, `not` are ordinary terms (already true in `src/lib/search/scan.ts`; now covered by tests).
- **Stemming scope (ADR-0035 as amended):** the English stem applies to English and `und` originals, all current translations and current summaries; foreign originals get the prefix match only.
- **Summaries stay searchable** (user decision): bare and quoted terms match summaries exactly on a `simple` index; `*` terms add the English stem.
- **NOT** still applies to the original text only (ADR-0027); `AND NOT renew*` uses prefix OR stem on the original.
- **Display (ADR-0032) is unchanged.**

### Consequences
- Good: the query language matches the requirements and is predictable; precision is the default and breadth is opt-in; no trigram work for Latin text (no per-search scans, no `trgm_index` dependence for Latin terms).
- Bad: a user who types `startups` no longer finds "startup" (they must type `startup*` or `startups*`; `startups*` finds "startup" through the stem); the English indexes are still paid for on the write path for a feature used only by `*` terms.
- Risks: wildcard queries are the slowest path (HP-1); a `*` on a stop word yields an empty stem query and falls back to prefix only.

### Confirmation
Search spec 0003 golden cases; plan tests on the three English expression indexes and the new `simple` summary index; parse tests for keyword case.
