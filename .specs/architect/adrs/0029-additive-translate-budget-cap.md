---
adr: 0029
title: Translation has its own daily cap, additive to the OpenAI cap
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0029: Translation has its own daily cap, additive to the OpenAI cap

## Context and problem statement
Translation uses a separate budget ledger key (`openai-translate`) so it cannot starve summaries (FP-8). That raises the question of whether the translate cap is carved out of the existing `BUDGET_OPENAI_DAILY` or added on top (plan 0003, B2).

## Considered options
1. Carve out: `BUDGET_OPENAI_DAILY` 7 plus translate 3, total 10.
2. Additive: `BUDGET_OPENAI_DAILY` stays 10, translate cap 3, total up to 13.
3. One shared key (rejected: translation can starve summaries).

## Decision outcome
Chosen option 2. `BUDGET_OPENAI_DAILY` is unchanged at 10 and `BUDGET_TRANSLATE_DAILY` defaults to 3, so total daily OpenAI spend can reach 13 in `BUDGET_CURRENCY`. Both are configuration; the translate default is a placeholder until model prices are known (ADR-0003).

### Consequences
- Good: existing summary enrichment behaviour is unchanged; translation is capped independently (ADR-0010 deferral applies per key).
- Bad: the combined ceiling is higher than the earlier single cap; operators must read both numbers. The status page and dashboard should show both ledgers.
