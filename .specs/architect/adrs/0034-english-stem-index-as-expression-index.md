---
adr: 0034
title: Hold the English search vector as an expression index, not a stored column
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0004-english-first-substring-search.md
supersedes: 0030 (only the wording "generated and GIN-indexed"; stemming itself stands)
---

# ADR-0034: Hold the English search vector as an expression index

## Context and problem statement
ADR-0030 chose English stemming and described a generated column with a GIN index. DBA spec 0004 found that adding a stored generated column rewrites `articles` under an exclusive lock and doubles the heap cost of the vector.

## Considered options
1. Generated stored column `search_vector_en` plus GIN.
2. Nullable column, trigger and batched backfill.
3. GIN expression index on `to_tsvector('english', search_text)`, no column (chosen).

## Decision outcome
Chosen option 3 on `articles` and on current `article_translations` (partial, `superseded_at IS NULL`), built with `CREATE INDEX CONCURRENTLY` in a `-- no-transaction` migration. The search compiler must emit the identical expression.

### Consequences
- Good: no table rewrite, no backfill, no null-before-backfill state.
- Bad: a query that does not repeat the exact expression silently loses the index; per-row recompute if a bitmap scan goes lossy.
- Risks: FP-DB1 (expression mismatch), FP-DB2 (invalid index left by an interrupted build).

### Confirmation
DBA spec 0004 experiments E2, E3 and E6 (plan tests).
