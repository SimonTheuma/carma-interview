---
adr: 0038
title: Non-Latin terms use substring matching whether quoted, bare or wildcarded
status: accepted
date: 2026-10-28
decision-makers: [simon@mavericks.mt]
raw-spec: ../0005-search-and-csp-hardening.md
supersedes: null
---

# ADR-0038: Non-Latin terms use substring matching whether quoted, bare or wildcarded

## Context and problem statement
`classifyLeaf` chooses `exact` for a quoted single word and `wildcard` for `term*` before it looks at the script. On unspaced scripts the PostgreSQL `simple` parser produces one token per punctuation-free run, so quoted `"人工智能"` and `科技*` matched 0 rows in sample article 9, and `"عقارات"` missed `العقارات` in article 8 (verified on PostgreSQL 16.3, architect spec 0005 section 3). This contradicts ADR-0007 (recall first, mode chosen by script) and P3.

## Decision drivers
- P3 completeness over precision; P5 script, not language label or quote, decides.
- No new infrastructure (ADR-0001).

## Considered options
1. Script-first substring for every non-Latin term (chosen).
2. CJK segmentation extension.
3. Document the limit only.

## Decision outcome
Chosen option 1. A term containing any non-Latin letter is a `substring` leaf (`ILIKE`, escaped) on original, translation and summary, whether it is bare, quoted (single or multi-word, the whole normalised phrase is matched) or ends in `*`. Latin terms keep ADR-0036 rules. This partly supersedes ADR-0031 and ADR-0036 for non-Latin terms: "quoted = exact" means whole-word only for scripts that have words separated by spaces.

### Consequences
- Good: quoted and wildcard Chinese/Arabic terms find their articles.
- Bad: matches inside longer words; terms of 1-2 characters cannot use the trigram index.
- Risks: FP-1, FP-2, FP-3 in the architect spec; the echo must not label these terms as exact.

### Confirmation
Script table unit test; golden cases on articles 8 and 9; plan reading for short terms.
