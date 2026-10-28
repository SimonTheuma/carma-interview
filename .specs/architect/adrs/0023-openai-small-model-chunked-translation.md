---
adr: 0023
title: Translate with the OpenAI small model, chunked by paragraph, full text
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0003-article-translation.md
supersedes: null
---

# ADR-0023: Translate with the OpenAI small model, chunked by paragraph, full text

## Context and problem statement
Choose provider and long-body handling (architect 0003, D2/D3).

## Considered options
1. OpenAI small model, chunking. 2. OpenAI, truncate. 3. Dedicated MT API.

## Decision outcome
Chosen option 1, prompt version recorded, untrusted text handled per ADR 0012, spend under ADR 0010 with a translation budget share (UNCONFIRMED size). Own breaker name so summaries are unaffected.

### Consequences
- Good: no new vendor; full text honoured.
- Bad: token cost about equal to body size; chunk join must be checked (FP-3).
