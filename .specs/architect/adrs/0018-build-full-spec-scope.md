---
adr: 0018
title: Build the full specified scope (track F); build time is not a constraint
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0018: Build the full specified scope

## Context and problem statement
The plan estimated the brief-minimum track (B) at 11.7 to 16.4 h and the full specs (F) at 21.0 to 32.7 h against the brief's 7 to 9 hour guidance. The user stated that the hour figure is a constraint on human effort only and that the build is well within budget.

## Considered options
1. Track B (brief-minimum)
2. Trimmed track B
3. Track F (everything in the specs), plus the optional observability profile and the COULD test tier

## Decision outcome
Chosen option 3. All tasks marked F in the plan are in scope, together with task 5.6 (Prometheus and Grafana profile, ADR-0014's optional profile) and the COULD test tier (soak, game days, disk-full, mixed load, visual bidi checks, full accessibility sweep). ADR-0001 still holds: the system is sized to 20 articles and the 50,000-a-day case; 800 articles/s remains a documented growth path. "Don't gold-plate" still applies to the README: it states what was built, why, and what was left out.

### Consequences
- Good: all failure points and hot paths in the specs have tests and measurements; fuller evidence for the graded criteria.
- Bad: more surface to keep consistent; the README must stay focused on decisions and trade-offs, not feature lists.
