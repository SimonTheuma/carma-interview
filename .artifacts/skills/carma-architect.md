---
name: carma-architect
description: Architecture and design analysis for Carma media-intelligence pipeline features. Given a feature requirement or set of requirements, analyses the existing codebase, proposes the optimum architecture and design changes (PostgreSQL-only, 800 articles/sec, 15-minute freshness), weighs PostgreSQL extensions such as queues and vector search where they help, puts trade-offs and conflicting priorities to the user as choices, registers points of failure and performance hot paths, designs resilience (failure classification, retries with backoff, circuit breakers, dead-lettering), seeds telemetry design, and records approved decisions as numbered ADRs under .specs/architect/. This is the entry point for every other carma-* skill. Use it whenever the user describes a Carma feature, ingestion, enrichment, search, scoring or dashboard requirement, asks "how should we build X", wants a design or approach reviewed, or mentions architecture, design, ADRs or trade-offs, even if they never name the skill.
---
 
# carma-architect
 
Turn a feature requirement into a design that fits the code that already exists and the principles Carma cares about. Everything downstream (searchability, DBA, telemetry, data sanity, testing, UX, planning) reads your output, so it has to be specific enough to act on and honest about what is unknown.
 
Read `references/carma-context.md` before anything else. It holds the principles (P1 to P11), the agreed constraints (PostgreSQL only, about 800 articles a second, 15 minutes from `published_at`, completeness over speed) and the spec conventions. Cite principles by number in your output so the reasoning can be checked. When a design could use PostgreSQL extensions (queues, vectors, partition automation, search), also read `references/postgres-extensions.md`.
 
## Workflow
 
### 1. Intake: restate the requirement
 
Restate the requirement in your own words, split into functional needs and non-functional needs (latency, volume, languages, confidence, audience). For each, note which principles it touches. Collect ambiguities in a list but do not ask yet; most become answerable once you have seen the code.
 
Skip questions the context file already answers. The constraints there are decided, so build on them instead of reopening them.
 
### 2. Analyse the codebase
 
Look before you design. A design that ignores the existing structure creates rework, and one that duplicates something already built wastes the team's time. If the repository is large, delegate the sweep to an Explore agent and ask for the conclusion, not file dumps.
 
Find and record, with file paths as evidence:
 
- **Shape.** Languages, frameworks, module boundaries, entry points, how the application is deployed and configured.
- **Ingestion path.** How articles arrive today, what validates them, where they are first persisted.
- **Data layer.** Schema, migrations, ORM or raw SQL, indexes, partitioning, connection handling, PostgreSQL version if discoverable.
- **Extensions.** Which are already enabled or installed (`CREATE EXTENSION` in migrations, container images, infrastructure code, `pg_available_extensions` if the database is reachable) and what the hosting environment permits. Unknown availability is a finding, not something to assume away.
- **Async work.** Jobs, workers, schedulers, any queue-like tables, retry behaviour. Remember there is no Kafka.
- **Enrichment.** Anything that calls an LLM or scorer, how confidence is produced and stored today.
- **Search.** Current query paths, full-text setup, language handling.
- **Observability.** Logging, metrics, tracing, health checks (carma-telemetry goes deeper; just note what exists).
- **Tests and CI.** Frameworks, coverage of the pipeline, load or integration tests.
- **Conventions.** Naming, layering, error handling, anything a new feature must follow.
If there is no code yet, say so. Greenfield changes the questions (you choose structure instead of adapting to it) but not the principles.
 
State what you could not determine. "Postgres version unknown" is more useful than a silent assumption.
 
### 3. Design
 
Propose the architecture that satisfies the requirement with the least disruption to what exists. For each significant decision, develop at least two real options (not a straw man), then recommend one and say why.
 
Lenses to apply, because they are where Carma pipelines tend to go wrong:
 
- **Throughput arithmetic.** At 800 articles a second, per-article cost dominates. Estimate cost per stage and compare to the budget in the context file. A synchronous call per article to a slow service is a design smell at this rate; batching, tiering (cheap checks first, expensive enrichment on a subset) and backpressure usually matter more than micro-optimisation.
- **Postgres as the backbone.** With no event platform, the database carries queues, state and results. Consider work claiming with `FOR UPDATE SKIP LOCKED`, an explicit per-item processing-state table, append-only writes instead of in-place updates, batch inserts, and keeping the hot write path light. Flag where the proposed load could contend with search reads. carma-dba will detail this; your job is to choose the shape.
- **Extensions as design options.** Postgres extensions can deliver reliability and searchability with little code: queue semantics with visibility timeouts and transactional enqueue (P2), vector search for meaning-based and cross-language matching and story clustering (P3, P5, P10), partition automation and scheduling, CJK-capable text search. Evaluate them using `references/postgres-extensions.md`: confirm availability, say which principle each serves and what it costs on the write path, and always keep a core-Postgres fallback in the design. A vector index supplements lexical matching for brand mentions; it never replaces it, because approximate search can miss (P3). Adopting an extension is a decision for the user, not a default.
- **Fresh before rich (P1, P3).** Items should become findable as soon as they land, with enrichment arriving afterwards. Design explicit states ("captured", "searchable", "enriched") so users and operators can tell them apart.
- **No silent loss (P2, P3).** Trace every way an article could be dropped, duplicated or stuck. Every exit from the pipeline needs a recorded reason.
- **Confidence and lineage (P6, P7, P8).** Wherever a value is derived, the design must say where confidence, origin, method and source references are stored.
- **Language neutrality (P5).** Nothing in the design may assume English, whitespace tokenisation or left-to-right text.
- **Human touchpoints (P9).** Mark where an analyst reviews or overrides.
- **Resilience (P2, P3).** Every dependency the pipeline calls (source feeds, scorers and LLMs, the database, object stores, other services) will be slow, wrong or down at some point. Design the response deliberately, per dependency, and record it in the "Resilience design" section. See `Resilience design` below.
- **Benchmarkability.** Quick benchmarks (carma-benchmark) are how we prove completeness and speed after each change, so design for them. Keep hot-path logic callable without the whole service (pure functions or small modules with explicit inputs), make the clock, random source and external dependencies replaceable at a seam, expose counters that let a run verify `received = accounted for`, and give the benchmark a way to run against a disposable database. If a requirement cannot be benchmarked, say why and what would make it so. Where a design choice makes benchmarking much harder, treat that as a cost in the trade-off.
- **Deployability.** Everything runs under Docker Compose on one host and must come up from a single `docker compose up`. Name every component that must run (database, workers, web app, observability), the settings and secrets each needs, and whether the capacity target fits one machine. carma-devops details this.
- **Reversibility.** Prefer designs that can be changed later. Flag one-way doors.
#### Resilience design
 
For each dependency and each stage boundary, decide and write down:
 
- **Failure classification.** Transient (timeouts, connection resets, 429 and 5xx, deadlocks, serialisation failures, brief failovers), permanent (malformed or missing source, 4xx other than 429, authentication or authorisation rejected, schema mismatch, content the scorer always rejects), and ambiguous (treat as transient for a bounded number of attempts, then as permanent). Retrying a permanent failure only burns capacity, and giving up on a transient one loses data, so the classifier is a design element in its own right and needs tests.
- **Retry strategy.** Which operations retry, how many attempts, exponential backoff with jitter (to avoid synchronised retry storms at 800 articles a second), a per-attempt timeout and an overall deadline tied to the 15-minute window, and a retry budget that caps retries as a share of traffic. Retries must be safe: only idempotent operations retry automatically, with idempotency keys or natural keys where an operation is not naturally idempotent. Decide whether retries live in the caller or in the database queue (attempt count, next-attempt time, last error, visible in the ledger).
- **Circuit breaker.** For each remote dependency, when the breaker opens (error rate or consecutive failures over a window, or latency over a threshold), how it half-opens with limited probes, how it closes, and per-dependency scope so one bad source or scorer does not trip the rest. State what the system does while it is open: queue the work durably, skip optional enrichment and mark the item "not yet enriched", or fall back to a cheaper method. State clearly what must not happen: dropping the item, or showing a default as if it were a result (P3, P6).
- **Bulkheads and limits.** Separate worker pools, connection pools and concurrency limits per dependency so a slow scorer cannot exhaust the connections the ingestion path needs; bounded queues and timeouts everywhere; backpressure rather than unbounded memory growth.
- **Permanent-failure handling.** After the attempt limit or on a permanent classification, the item moves to a dead-letter or quarantine state with the reason, attempts, last error and timestamps. It stays visible, can be replayed after the cause is fixed, and counts in the reconciliation totals. A permanently unreachable source produces a visible coverage gap (P3), not silence.
- **Degraded modes.** What a user sees when a dependency is down: items searchable without enrichment, confidence shown as "no confidence available", freshness and coverage banners. Late items are flagged as late.
- **Recovery.** Catch-up must outrun arrival; replay is rate-limited so recovery does not become the next outage; breakers close gradually.
- **Poison-item and loop protection.** A bounded attempt count per item and per stage, so one article cannot cycle forever (cost controls are detailed in carma-data-sanity).
Where the decision is a real trade-off (for example how long to keep retrying inside the 15-minute window before declaring a mention late, or whether to queue or skip during an outage), put it to the user.
 
### 4. Trade-offs and user decisions
 
When something is unclear, or two priorities conflict and the principles do not settle it, stop and put the choice to the user. Do not bury a consequential choice inside the design. Follow the "When to ask the user" protocol in the context file: grouped questions, options with their cost and benefit in a line, a recommendation first.
 
Typical triggers: build versus extend an existing component, a schema change that is hard to reverse, throughput versus durability settings, enrichment cost versus coverage, a requirement that conflicts with a principle, scope that the requirement leaves open, and whether to adopt a Postgres extension (offer packages: core only, core plus operational basics, extended; see the extensions reference).
 
Record every open choice in the spec under "Decisions needed", with its options, whichever way it is resolved.
 
### 5. Points of failure register
 
List the ways the feature can fail or silently go wrong. This register becomes the focus of the testing skill, so write entries a tester can turn into test cases.
 
| ID | Failure point | Failure mode and effect | Principle at risk | How we would detect it |
| --- | --- | --- | --- | --- |
| FP-1 | e.g. Worker crashes after claiming a batch | Articles stuck "in progress" forever, mentions missed | P2, P3 | Claim age metric, stuck-item sweeper |
 
Cover at least: ingestion (bad or missing fields, duplicates, out-of-order or late arrival), state transitions, retries and poison items, database saturation and failover, enrichment dependency failures, backlog and catch-up, clock and timestamp issues, language and encoding edge cases, and anything where an item can disappear without a recorded reason.
 
### 6. Hot path register
 
Identify the code paths that run per article or per query at volume, or that touch shared contended resources. These need extra human attention or manual inspection, and they are the input for the performance skill that follows.
 
| ID | Path | Why it is hot | Expected load | What needs a human | Suggested measurement |
| --- | --- | --- | --- | --- | --- |
| HP-1 | e.g. Batch insert into the articles table | Every article passes through, index maintenance multiplies cost | 800 rows/s sustained | Review index set and batch size against the write budget | Rows/s and p99 commit time under sustained load |
 
"What needs a human" is the important column. Say specifically what judgment a person must apply (review a query plan, inspect a regex, decide a batch size, approve a timeout), not just "review this".
 
### 7. Telemetry starting points
 
List the signals this design needs so the infra team can hold the reliability and performance targets and developers can debug special cases. Keep it to starting points; carma-telemetry builds the full plan.
 
Always include: end-to-end freshness measured from `published_at`, capture lag versus processing time per stage, throughput in and out per stage, queue depth and oldest-item age, reconciliation counts (received = accounted for, by outcome and reason), error and retry rates, and one signal per entry in the failure register.
 
### 8. Downstream handoff
 
State which follow-on skills apply and what each needs from this spec:
 
- **carma-searchability**: applies if any requirement involves querying the data. Say what is searched and how often.
- **carma-data-sanity**: applies if untrusted content is ingested or sent to an LLM, which is nearly always.
- **carma-dba**: applies if storage, indexes or write paths change. Tell it which extensions the design leans on and the fallback, so it can verify availability and cost.
- **carma-telemetry**: applies to any feature that runs in production.
- **carma-ux**: applies if a person sees or interacts with the result.
- **carma-devops**: applies to anything that must be deployed or run, which is nearly always. Give it the components, settings, secrets and capacity numbers.
- **carma-backend-testing**: applies once the design and database plans exist. It turns the FP register and the resilience design into negative, fault and recovery tests.
- **carma-plan**: last, to combine everything.
- **carma-benchmark** and **carma-review** run outside this flow, after code changes. Tell them which HP entries deserve a benchmark and which paths must stay simple for human review.
## Output
 
Write the spec with these sections, in this order, so downstream skills know where to look:
 
1. **Summary** (the design in a short paragraph and the main decision it asks for)
2. **Requirements digest** (functional, non-functional, principles touched)
3. **Codebase findings** (with paths; unknowns listed)
4. **Proposed architecture** (components, data flow, states, where confidence and lineage live; a diagram in text or Mermaid where it helps)
5. **Options considered** (per significant decision: options, trade-offs, recommendation; include any extension candidates with availability status, principle served, cost and core fallback)
6. **Decisions needed** (open choices for the user, each with options and recommendation)
7. **Points of failure** (FP register)
8. **Resilience design** (table per dependency: failure classes, retry policy, circuit breaker, bulkhead, permanent-failure handling, degraded mode)
9. **Hot paths** (HP register)
10. **Telemetry starting points** (include breaker state, retry counts, dead-letter depth)
11. **Principle alignment** (table: principle, how the design serves it, what it costs)
12. **Downstream handoff** (which skills, what they need)
13. **Open questions and assumptions** (mark unconfirmed assumptions `UNCONFIRMED`)
## Persisting the work (when run inside a codebase)
 
See "Spec conventions" in the context file for what counts as a codebase, front matter and numbering.
 
1. **Raw design doc.** Get the number with `python scripts/next_spec_number.py .specs/architect` and write `.specs/architect/NNNN-<feature-slug>.md` with `spec: carma-architect` front matter and `status: draft`. This is the full output above, written before any decision is codified.
2. **ADRs after human decisions.** When the user decides an open choice or approves the plan, record each decision as its own numbered ADR in `.specs/architect/adrs/` (number with `python scripts/next_spec_number.py .specs/architect/adrs`). One decision per ADR. Only write ADRs for decisions a human has actually made or approved; an `UNCONFIRMED` default is not a decision.
3. **Link them.** Add the ADR numbers to the raw doc under a "Decisions recorded" heading, and set `status: approved` once the user approves the design. Each ADR points back to the raw doc.
If the repository already keeps ADRs somewhere else (for example `docs/adr`), ask the user whether to follow that convention or use `.specs/architect/adrs`. Do not scatter ADRs across two places.
 
If you are not in a codebase, deliver the output in the conversation and offer to save it.
 
### ADR format (MADR-style)
 
```markdown
---
adr: 0003
title: Claim enrichment work with SKIP LOCKED in Postgres
status: accepted          # proposed | accepted | superseded | rejected
date: 2026-10-24
decision-makers: [name or role]
raw-spec: ../0002-article-ingestion.md
supersedes: null
---
 
# ADR-0003: Claim enrichment work with SKIP LOCKED in Postgres
 
## Context and problem statement
What forced the decision, in two or three sentences. Link the requirement and the constraint that bites (for example, no event platform).
 
## Decision drivers
- P2 reliable: work must survive worker crashes
- Throughput: 800 articles/s sustained
 
## Considered options
1. Option A
2. Option B
3. Option C
 
## Decision outcome
Chosen option: "Option B", because it best satisfies the drivers above.
 
### Consequences
- Good: ...
- Bad: ...
- Risks and how we will notice them: link FP/HP entries
 
### Confirmation
How we will know it works: tests (FP-n), telemetry signals, measurements (HP-n).
 
## Pros and cons of the options
Short, honest list per option.
```
 
## Quality bar
 
Before finishing, check: every significant claim about the codebase cites a path; every FP and HP entry is specific enough to test or measure; every principle is either served or its cost is named; open questions are marked rather than hidden inside the design. A design that reads as certain about things nobody has verified is worse than one that lists its unknowns.