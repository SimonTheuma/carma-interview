---
adr: 0002
title: Next.js (TypeScript) full-stack app with PostgreSQL, Docker Compose
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0002: Next.js (TypeScript) with PostgreSQL

## Context and problem statement
The brief names no mandatory stack ("Node / React, PostgreSQL, etc.") and asks for a runnable service with API and UI. The user first proposed a Tauri app with Rust and Astro. Tauri builds desktop apps, which conflicts with the `docker compose up` requirement, so the user reverted to the original Next.js stack.

## Decision drivers
- Runs under one `docker compose up` (Carma constraint, brief F9)
- Fit to a 7 to 9 hour budget; one language across API, worker and UI
- Typed SDKs exist for both enrichment providers (jev: `@typesafe-ai/sdk`, Node 20+)

## Considered options
1. Next.js (TypeScript), PostgreSQL, worker as a second process from the same codebase
2. Rust service + Astro frontend + PostgreSQL
3. Tauri desktop app

## Decision outcome
Chosen option: "Next.js (TypeScript) + PostgreSQL". Route handlers serve the API; a separate `worker` container runs the enrichment loop from the same repository. SQL is hand-written and parameterised (no ORM-built string interpolation).

### Consequences
- Good: one language and toolchain; fast to build; SDK types for jev.
- Bad: a framework that blends UI and API, so API boundaries need discipline; the worker is not a Next.js concern and must live outside route handlers.
- Risks: bundler and server-component defaults could leak server-only code to the client. Confirm with a build check (see devops spec).

### Confirmation
Compose brings up `db`, `app`, `worker`; the UI renders ids 6 and 18 safely (FP-6).

## Pros and cons of the options
1. Fast, typed, matches the brief; framework coupling.
2. Strong performance and safety; slower to build, more risk in the time budget.
3. Does not satisfy the runnable-service requirement.
