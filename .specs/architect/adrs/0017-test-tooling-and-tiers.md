---
adr: 0017
title: Vitest, React Testing Library and Playwright with MUST/SHOULD tiers
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0017: Vitest, React Testing Library and Playwright with MUST/SHOULD tiers

## Context and problem statement
The test plan needs tooling and a time budget that fit the assignment (testing TS1, TS2).

## Considered options
1. Vitest + RTL + Playwright, about 20 to 25% of build time, MUST/SHOULD/COULD tiers (recommended)
2. `node:test`, MUST only
3. Larger suite with soak and game days

## Decision outcome
Chosen option 1. COULD tier (soak, game days, disk-full) is the first cut.

### Consequences
- Good: evidence for the graded criteria; one TypeScript toolchain.
- Bad: Playwright adds image size; time pressure may cut SHOULD items.
