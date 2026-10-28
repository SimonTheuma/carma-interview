---
adr: 0015
title: Custom SVG bar chart with an always-available table
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0015: Custom SVG bar chart with an always-available table

## Context and problem statement
The trends view needs a chart that meets the labelling and accessibility rules (UX1).

## Considered options
1. Small custom SVG bar component plus table (recommended)
2. Charting library

## Decision outcome
Chosen option 1.

### Consequences
- Good: no dependency; full control of patterns and accessible names.
- Bad: a little more code than a library for stacked series.
