---
spec: carma-review
number: 0001
title: First-pass quality review of the Media Signal Service build
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/plan/0001-media-signal-service.md
  - .specs/architect/0001-media-signal-service.md
  - .specs/architect/adrs/ (0001 to 0018)
  - .specs/data/dba/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
  - .specs/devops/0001-media-signal-service.md
  - .specs/telemetry/0001-media-signal-service.md
  - .specs/testing/backend/0001-media-signal-service.md
principles: [P2, P3, P6, P7, P8]
supersedes: null
---

# Review 0001: Media Signal Service, first pass

## 1. Verdict and summary

**Verdict: Approve with changes.** No secret leak. Two data-integrity defects in the worker and a large test gap need fixing before this is called done.

Reviewed: the whole working tree. Nothing is committed beyond the Create Next App commit, so the review covers all 126 untracked files plus the modified config. Mechanical checks: `tsc --noEmit` clean, `vitest run` 21/21 passing, `eslint` reports 5 errors and 5 warnings.

Top findings:
1. **Blocker.** `finishSentiment` and `finishSummaryTopics` return `false` when the job claim was lost (`src/worker/finish.ts:72`, `:173`), but the caller commits regardless (`src/worker/loop.ts:210`, `:248`). A worker whose claim expired still writes its `enrichments` and `derived_values` rows. A reclaimed job then writes a second set. Nothing in the visible code supersedes the earlier rows.
2. **Should fix.** Only 5 unit test files exist. `tests/integration`, `tests/fakes`, `tests/fixtures` and `tests/harness` are empty. The testing spec's failure-point tests (including `F-BRK-ATT`, which the plan makes a gate) have no implementation.
3. **Should fix.** The ingest hot path does one connection checkout plus 4 to 7 sequential round trips per article, one article at a time (`src/lib/ingest/ingest.ts:51`). This is fine for the ADR-0001 assignment sizing. It is not on the path to 800/s without a rewrite.

## 2. Scope reviewed

- Change: working tree vs `30d386c`; `app/` deleted and replaced by `src/app/`.
- Plan used: `.specs/plan/0001`, build target is track F per ADR-0018.
- Specs and ADRs: all present for this feature.
- Not available: `.benchmarks/` does not exist, so there is no measurement evidence. `reports/measurements.md` is 17 lines and was not treated as a benchmark.
- Not reviewed in depth: UI components (`src/components/**`), Grafana dashboard JSON, `src/lib/search/parse.ts` internals, `src/lib/providers/*`.

## 3. Plan conformance

Matched by area, since the build does not reference task ids.

| Area | Status | Evidence |
| --- | --- | --- |
| Compose skeleton, secrets-init, healthchecks, read-only containers, cap_drop | Delivered | `compose.yaml`, `ops/init-secrets.sh` |
| Schema, roles, grants, migrations | Delivered | `db/migrations/0001`, `0002`; per-role grants at `0001_init.sql:222-250` |
| Ingest, validation, quarantine, transformation record | Delivered | `src/lib/ingest/ingest.ts` |
| Search grammar, compile, filters, cursor | Delivered | `src/lib/search/*` |
| Worker, claim, breaker, retry, budget, sweeper | Delivered, with defects (F1, F4, F6) | `src/worker/*` |
| UI: search, trends, article, status | Present, not reviewed in depth | `src/components/*` |
| Observability profile (5.6) | Delivered | `ops/`, `src/lib/metrics.ts` |
| Test tiers (MUST and COULD, 5.7) | **Mostly not delivered** | Only unit tests exist; integration, fakes, harness and fixtures dirs are empty |
| Benchmark gates (2.7, 3.8) | **Not delivered** | no `.benchmarks/` |
| Plan K1 (breaker check before claim, release decrements attempts) | Delivered, test missing | `loop.ts:51`, `claim.ts:57`; the `F-BRK-ATT` test is absent |

## 4. Trade-off and spec conformance

| Decision | Status | Evidence |
| --- | --- | --- |
| P3 over P1: no silent drop | Mostly respected | Invalid items go to `ingest_quarantine` (`ingest.ts:84`, `:119`). **Gap:** an exception in `ingestOne` rethrows (`:247`), so `loadArticles` aborts the batch. The remaining items are never attempted and no ledger row is written. |
| PostgreSQL only (ADR-0002) | Respected | Queue is `FOR UPDATE SKIP LOCKED` in `claim.ts`. No new infrastructure. |
| Processing-state ledger, idempotency | Partly respected | `ON CONFLICT (source, external_id) DO NOTHING`, with a `duplicate` event. Job-finish idempotency is broken (F1). |
| Resilience: classification, backoff, breaker, dead-letter | Respected, minor issues | `classify.ts`, `retry.ts`, `breaker.ts`; dead rows keep `reason_code` and `last_error`. See F4 and F7. |
| Confidence and lineage (ADR-0004, P6 to P8) | Respected | `derived_values` stores norm, raw, min, max, origin, method (`finish.ts:49`). Mock origin is labelled (ADR-0013). |
| Text-first, markup reduced and recorded, payload hash kept | Respected | `reduceMarkup`, `ingest_transformations`, `payload_sha256` |
| Language neutrality (P5, ADR-0007) | Respected | Arabic and CJK scripts routed to substring match (`leaf.ts`) |
| Null and error assumptions | Respected | Validation returns reason codes; nullable headline and body |
| Injection (ADR-0012) | Respected | `detectInjection` flags and lowers trust (`loop.ts:115`) |
| Parameterised SQL | Respected | `compile.ts` uses only numbered params. ILIKE terms are escaped. |
| Daily LLM budget and deferral (ADR-0010) | Respected | `loop.ts:132-151` |
| Provider-output cache | **Not implemented** | `loop.ts:166-181` looks up the cache, then ignores the result. See F5. |
| Telemetry | Respected | `metrics.ts`, `/api/metrics`, alerts, breaker flags |

## 5. Hot path review

The register in `.specs/architect/0001` was not enumerated line by line. The two hot candidates are the ingest path and the worker loop.

**Ingest (`ingest.ts`)**
- The quarantine insert is copy-pasted (`:85-106` and `:121-142`). Extract one `quarantine(client, ...)` helper. This is the most useful readability win.
- `process.env.ROLE = process.env.ROLE ?? "seed"` followed by `process.env.ROLE ? loadConfig() : getConfig()` (`:32-33`) always takes the first branch. It mutates global state, and the dead conditional misleads readers. Pass the role in explicitly.
- Per article: connect, BEGIN, SELECT for duplicate hash, INSERT, INSERT event, N transformation INSERTs, 2 job INSERTs, COMMIT. Batching is not needed at assignment scale. If 800/s is ever pursued, multi-row inserts per batch are the first step, and a benchmark must come first.
- The comment "Repair NULs / lone surrogates" (`:115`) only handles NUL. Lone surrogates are not repaired.
- The duplicate-hash check then INSERT is not atomic, but it only sets a flag, so that is acceptable.

**Worker (`loop.ts`)**
- `processJob` is about 215 lines, and the sentiment and summary branches are near copies. Split into `reserveBudget`, `callProvider` and `recordFailure`. Keep each branch short enough to read in one sitting.
- Dead code: the empty `if (cached.rows[0]) {}` block at `:177-180` with a "for simplicity" comment. Either implement cache reuse or delete the lookup, which is a wasted query per job.
- The claim batch size is hard-coded to 1 (`:62`) and the loop runs one job at a time. `WORKER_CONCURRENCY_*` from `.env.example` appears unused in the loop. Check this.

**Measurement:** none. `.benchmarks/` is missing, so no claim about throughput can be verified.

## 6. Secrets and sensitive information

Checked: pattern search over all untracked and modified files for key formats, `password`, `secret`, `token`, `BEGIN PRIVATE KEY` and connection strings with credentials. Also checked `.gitignore`, `.dockerignore`, `.env.example`, `compose.yaml`, the Dockerfile and the log redaction list.

**No real secrets found.**
- `.env.example` contains placeholders only; provider keys are commented out. `.env`, `.env.*` and `/secrets/` are ignored (`!.env.example` is preserved).
- Passwords are generated at runtime by `ops/init-secrets.sh` and passed as `*_FILE` secrets. No credentials appear in the image or in compose environment values.
- The DB is not published in the base compose file. Only `compose.dev.yaml` publishes it, bound to 127.0.0.1. Web, Prometheus and Grafana also bind to 127.0.0.1.
- `data/sample_articles.json` contains an `evil.com` script string. It is an intentional XSS and injection test fixture, not a leak.

Findings:
- **Should fix (S1).** `compose.yaml:232`: `GF_SECURITY_ADMIN_PASSWORD: admin`, a default credential. Loopback-bound and behind the `observability` profile, so low risk. Load it from a generated secret like the others.
- **Consider (S2).** `ops/init-secrets.sh:42`: `chmod -R a+rX` makes every secret world-readable inside the shared volume, and each service mounts only its own subpath, which limits exposure. Still, `600` with the right uid is tighter.
- **Consider (S3).** `last_error` stores `err.message.slice(0, 500)` (`loop.ts:279`, `:296`). Provider error messages can echo request fragments. Confirm that they cannot contain the API key or article text.
- **Consider (S4).** The log redaction list covers only `*.apiKey`-style paths one level deep. Add the `err.config.headers` shape for HTTP clients.
- **Cleanup.** `.cursor/`, `dist/`, `tsconfig.tsbuildinfo` and `.next/` exist locally. `dist` and `.next` are ignored; `.cursor` is empty. `.specs/references/__MACOSX/` is junk and is not covered by an ignore rule.
- **Before the first commit.** Nothing has been committed. When committing, the Create Next App commit history is clean. `.specs/references/Senior-Fullstack-Home-Assignment.pdf` is the client brief. Decide deliberately whether it belongs in the repository.

## 7. Other findings

**Blockers**
- **F1.** `src/worker/loop.ts:196-211` and `:234-249`; `src/worker/finish.ts:65-72`, `:166-173`. The finish functions insert `enrichments` and `derived_values` first, then conditionally update the job. When the update matches zero rows (claim swept and reclaimed), the function returns `false` but the transaction still commits and `breaker.onSuccess()` runs. Result: duplicate current enrichments. The `enrichments_current_uq` unique index (`0001_init.sql:95`) may reject the second insert and turn this into a repeated failure instead. Fix: do the `UPDATE ... WHERE claimed_by AND state='running'` first, and `ROLLBACK` when `rowCount !== 1`. Release the budget reservation in that case too.

**Should fix**
- **F2.** `tests/integration`, `fakes`, `harness` and `fixtures` are empty. At minimum add: `F-BRK-ATT`, the lost-claim race (F1), duplicate delivery of the same article, quarantine of a malformed item mid-batch, and a budget-exhaustion deferral test.
- **F3.** `ingest.ts:247`: one failing item aborts the batch. Under P3 the failure should be recorded (an event row with outcome `error`, or a quarantine reason) and the loop should continue. Rethrow only for connection-level errors.
- **F4.** Lint has 5 errors. Two are in the reviewed hot code: `loop.ts:181` and `reduce.ts:100` (`prefer-const`). Three are `setState` inside `useEffect` in `FilterBar.tsx:29`, `SearchPage.tsx:128` and `TrendsPage.tsx:22`. Run `npm run lint` in CI as a gate.
- **F5.** `loop.ts:166-181`: the cache lookup is dead code. Implement reuse (the schema already stores `input_hash`) or remove it. It currently costs one query per job and suggests a cost saving that does not happen.
- **F6.** `loop.ts:59-92`: the claim transaction commits before `processJob`. If the process dies between those points, the visibility timeout (180 s) handles recovery. That is correct, but there is no heartbeat extension. A provider call with `CALL_TIMEOUT_MS=30000` and retries is safe at those defaults, but link the two values in config validation.
- **F7.** `breaker.ts`: in `half_open`, `canRequest` returns true for every caller, so it does not enforce "single probe". With concurrency 1 it holds. It will not once worker concurrency is raised.
- **F8.** `classify.ts:6`: matching on the message substring `"schema"` also catches unrelated errors such as a database "schema" message. Classify by a typed error from `validate-output.ts` instead.
- **F9.** `retry.ts:9-11`: the jitter is derived from `clock.now() % 500`, which is deterministic per millisecond and clumps across workers. Fine for the PoC; note it.

**Consider**
- `Dockerfile` and `compose.yaml` pin image versions (`postgres:16.6-bookworm`, `alpine:3.20.3`). Good. Consider digest pins before any production use.
- `aggregate`, `facets`, `readyz` and `search` routes create and end a pool per request. This is safe but costly under load. Reuse a module-level pool, as `src/lib/db/pool.ts` probably intends.
- `app_read` has `statement_timeout = '2s'` (`0001_init.sql:250`). Good. Confirm the ILIKE substring search on large corpora stays within it, since ADR-0007 accepts the trigram index cost.

**Praise**
- Per-role database grants, including column-level `UPDATE (is_current)` and `UPDATE (superseded_at)`, are strict and match the DBA spec.
- Read-only containers, `cap_drop: [ALL]`, internal-only data network and `*_FILE` secrets are a solid deployment baseline.
- Confidence storage is complete and honest: origin and method travel with each number, and mock values are labelled.
- Search compilation is parameter-only, with escaped ILIKE input, and the quarantine path preserves every rejected payload.
- The ADR trail (0001 to 0018) is thorough and the code follows it closely.

## 8. Unverifiable items and follow-ups

- Containers were not started, so nothing about `docker compose up` working from a clean machine, migrations at start-up, or the seeded dataset was verified. Run `scripts/smoke.sh` and record the result.
- The search, trends and article UI, the e2e smoke test and the Grafana dashboard were not exercised.
- No throughput, freshness or conservation evidence exists. Run `carma-benchmark` for the ingest path and for the worker's claim-to-finish path.
- Re-run this review after fixing F1 to F3, and again after the first commit so the diff is reviewed against a base.
- Open question for the user: should the assignment brief PDF and `__MACOSX` files be committed? Add an ignore rule for the second.
