---
adr: 0019
title: Upload route writes through a second app_ingest pool in web and processes the file synchronously under caps
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0002-json-file-upload.md
supersedes: null
---

# ADR-0019: Upload route writes through a second app_ingest pool in web and processes the file synchronously under caps

## Context and problem statement
The web service holds only the read-only `app_read` credential. A JSON upload needs to insert articles, events and jobs. Architect 0002 D1 and D2.

## Decision drivers
- P2 reliable (per-item transactions, transactional enqueue, idempotent re-upload)
- ADR 0001: assignment scope, do not gold-plate
- P1: admitted articles searchable before enrichment

## Considered options
1. Second `app_ingest` pool in web, synchronous under caps (chosen)
2. Stage the file in a table, worker ingests
3. Separate ingest service

## Decision outcome
Chosen option 1. The upload route alone uses the `app_ingest` pool (never the read routes). Caps `UPLOAD_MAX_BYTES` and `UPLOAD_MAX_ITEMS` (defaults 5 MiB, 1000, UNCONFIRMED) bound the request; one upload in flight per web instance.

### Consequences
- Good: reuses `loadArticles`; smallest change; full per-article report in the response.
- Bad: web can now write if compromised; long requests tie up the ingest pool; no resumable upload.
- Risks and how we will notice them: FP-4, FP-5, FP-8; HP-1 measurement.

### Confirmation
Backend tests for FP-1..FP-12, benchmark of HP-1, pool wait metric.

## Pros and cons of the options
1. Simple and fast to build; widens web privileges.
2. Durable and isolated; new table, worker stage, delayed visibility.
3. Strongest isolation; most Compose work.
