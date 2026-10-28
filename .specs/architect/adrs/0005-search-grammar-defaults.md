---
adr: 0005
title: Boolean search grammar defaults
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0005: Boolean search grammar defaults

## Context and problem statement
The brief fixes the operators (`AND`, `OR`, `AND NOT`, brackets, phrases, `*`) and says keywords are case-sensitive. It leaves precedence, bare adjacent terms and wildcard placement open.

## Considered options
1. Lenient: `AND` binds tighter than `OR`; adjacent bare terms are an implicit `AND`; a leading `NOT` is a parse error (only `AND NOT` negates); wildcard as suffix only
2. Strict: explicit operators and brackets everywhere

## Decision outcome
Chosen option 1. Lowercase `and`, `or`, `not` are ordinary terms. Parse errors return a clear message with the position. Query length, nesting depth and term count are capped (values set by carma-searchability).

### Consequences
- Good: forgiving for users; the index can always be used.
- Bad: implicit `AND` can hide a typo such as a missing `OR`; mitigated by showing the parsed query back to the user.
