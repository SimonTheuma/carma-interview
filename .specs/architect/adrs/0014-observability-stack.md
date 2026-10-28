---
adr: 0014
title: Observability: JSON logs, /metrics, health endpoints, status page, trace endpoint
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0014: Observability: JSON logs, /metrics, health endpoints, status page, trace endpoint

## Context and problem statement
Carma wants observable pipelines; the assignment excludes deployment infrastructure and has a 7 to 9 hour budget. Telemetry T1.

## Considered options
1. Logs + `/metrics` + status page + per-article trace, no extra containers; Prometheus/Grafana as an optional profile (recommended)
2. Build Prometheus + Grafana in the core deliverable
3. Logs and status page only

## Decision outcome
Chosen option 1.

### Consequences
- Good: no extra containers; the ledger is the source of truth.
- Bad: no ready-made dashboards unless the optional profile is built.
