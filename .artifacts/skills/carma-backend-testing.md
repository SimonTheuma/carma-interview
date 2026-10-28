---
name: carma-backend-testing
description: Creates a backend test plan for Carma pipeline features from the carma-architect and carma-dba outputs. Focuses on proving data stays complete and correct as it moves through every pipeline stage (conservation and reconciliation checks, idempotency, fault injection, multilingual round trips) and on resilience, covering negative testing, retry policies, circuit breakers and dead-letter handling for permanent failures and on profiling and proving soft requirements such as the 15-minute freshness target and 800 articles/sec load handling. Maps every failure point to tests and every hot path to a measurement. Writes numbered specs to .specs/testing/backend/. Use whenever the user asks for a test plan, test strategy, load or performance testing, data-integrity testing or "how do we prove this works" for a Carma backend feature, and after carma-architect and carma-dba, even if the skill is not named.
---
 
# carma-backend-testing
 
In this pipeline the most dangerous bug is the silent one: an article that goes in and never comes out, comes out altered, or arrives after the window. Ordinary functional tests rarely catch it. This skill plans tests that prove **no data is lost or corrupted between stages**, and that the **soft requirements** (time taken, load handled) are met with evidence rather than assertion.
 
The output is a plan, not test code. Only write tests if the user asks for them as a follow-up.
 
Read `references/carma-context.md` first for the principles, constraints and spec conventions.
 
## Inputs
 
Read the latest non-superseded specs for the same feature: `.specs/architect/` (data flow, states, FP and HP registers), `.specs/data/dba/` (schema, write path, verification plan), and, if present, `.specs/search/` (recall evaluation plan), `.specs/data/sanitization/` (security test inputs), `.specs/telemetry/` (signals tests can assert on) and `.specs/devops/` (the Compose stack the tests run against, and the deployment tests that carma-devops already covers: clean bring-up, upgrade, backup and restore, secrets). Do not duplicate those; use the same disposable Compose environment for integration, load and fault tests. The FP registers across those specs are the backbone of this plan: each failure point must map to at least one test. Each HP entry must map to a measurement. If the architect or DBA spec is missing, say so and ask.
 
Inspect the codebase for how tests are done today: language, framework, runner, fixtures, whether integration tests use a real database, existing load tooling and CI configuration. Match what is there; recommend new tooling only where a real gap exists. Record paths. Check `.benchmarks/` too: quick Node.js benchmarks written by carma-benchmark cover single changes; this plan covers the full suite, soak and fault tests. Reuse their generator and thresholds where they exist so the numbers agree, and do not duplicate them.
 
## Workflow
 
### 1. Data integrity and completeness across stages
 
Define the invariants first, then the tests that attack them.
 
- **Conservation.** For a controlled input set, every article is accounted for at every stage boundary: `received = indexed + rejected + quarantined + dead-lettered + duplicate`, each with a reason. No stage may change the total silently. Specify the reconciliation query or check at each boundary and run it after every scenario.
- **Fidelity.** An article's text content is stored faithfully (compare hashes of the extracted text end to end), the reduction of any markup to text is recorded as a transformation, and derived fields reference their source. Include a round trip through storage and search for English, Arabic and Chinese, with right-to-left text, mixed scripts, emoji, combining characters, very long bodies, and characters that tend to break things (NUL, zero-width, bidirectional controls). Add markup-to-text cases: nested tags, scripts and styles, HTML entities, hidden elements, and Arabic and Chinese text inside markup.
- **Idempotency.** Delivering the same article twice, or reprocessing a batch, produces the same state and no duplicates. Reordering and late arrival do not corrupt state.
- **Ledger correctness.** Processing-state records match reality: nothing stuck "in progress" after a worker dies, nothing marked done that is not.
- **Confidence and lineage (P6, P7, P8).** Every derived value has a normalised confidence in 0 to 100, with raw value, range, origin and method recorded; normalisation is correct at the boundaries of each scorer's min and max; values that cannot be scored show "no confidence available" rather than a number.
- **Search completeness (P3).** Planted mentions in each language are found (from the searchability evaluation plan), and an article that is stored is searchable once its state says so.
### 2. Failure-point coverage
 
Build a table that traces every FP entry (from the architect, searchability, DBA and data-sanity specs) to the tests that exercise it. For each, choose the technique that fits:
 
- Fault injection: kill a worker mid-batch, drop the database connection, fail over the database, exhaust the connection pool, stall a dependency, return garbage from the scorer, fill the disk, skew the clock.
- Poison and malformed input: invalid or oversized fields, missing or future `published_at`, duplicate ids, unsupported language, hostile content from the data-sanity spec.
- Backpressure and recovery: a backlog builds, then clears; catch-up must exceed the arrival rate.
- Expected outcome for each: the recorded reason, the metric or log that appears, and the state the system returns to.
An FP with no test is a gap; list it and say why or what is needed.
 
### 3. Soft requirements: profile and prove
 
State each as a measurable claim with a threshold, a method and the evidence kept.
 
- **Freshness.** From `published_at` to searchable and to delivered for a mention: the share within 15 minutes and the p50, p95, p99 and maximum, under sustained load. The only agreed target is 15 minutes; any other threshold is proposed and labelled so.
- **Throughput.** 800 articles a second sustained for a long enough soak to expose leaks, bloat and checkpoint effects (duration chosen to span several autovacuum and checkpoint cycles), plus peak and burst profiles above the base rate.
- **Load shapes.** Steady, ramp, burst, backlog-then-recover, and mixed search plus ingestion (reads must not starve writes, and the reverse).
- **Resource behaviour.** CPU, memory, connections, WAL rate, replication lag and index size under load, so capacity headroom is known.
- **Latency of interfaces.** Request and response times per endpoint and per key query, with percentiles rather than averages.
- **Hot paths.** For each HP entry, a measurement (profile, query plan, microbenchmark, or load test slice) and what result would trigger the human inspection the architect asked for. This is the interim performance coverage until a dedicated performance skill exists.
- **Language mix.** Load tests use realistic proportions of English, Arabic and Chinese, since analysis cost differs by language.
Specify the load generator: it produces articles in the agreed schema with seeded randomness (reproducible), realistic size distribution, planted mentions at a known rate, duplicates and late arrivals at a known rate, and a controllable language mix. Results are recorded with environment details (hardware, database settings, version, data volume), because a performance number without its environment cannot be compared or trusted.
 
### 4. Resilience and negative testing
 
The architect's resilience design (retry policies, circuit breakers, bulkheads, dead-letter handling, degraded modes) is a set of promises. This step plans tests that try to break each one. Start from the per-dependency table in that spec; if it is missing, say so and derive the dependencies from the FP register.
 
**Negative testing principles.** Test what must not happen as deliberately as what must. For every function and boundary: invalid, missing, null, oversized, malformed, wrongly typed, out-of-range and out-of-order input; duplicates; unexpected state (acting on an item that is already done, locked or gone); unauthorised or expired credentials; and boundary values on both sides of every limit. Each negative test states the expected safe outcome: rejected or quarantined with a recorded reason, a clear error, no partial writes, no data loss, no crash, and no secret or stack trace leaked. Cover every row of the null matrix from the data-sanity spec when it exists.
 
**Dependency failure modes.** For each dependency, inject each of: connection refused, timeout (slow but not dead), slow responses that push latency past the threshold, intermittent errors at a controlled rate, hard 4xx and 5xx responses, rate limiting with `Retry-After`, malformed or truncated responses, valid-looking but wrong responses (a score outside its range, an unsupported language), partial success in a batch, and an outage that lasts longer than the retry window. Use a controllable fake or fault-injection proxy so failures are reproducible, and keep the real dependency out of the loop.
 
**Retry behaviour.** Verify: transient failures retry and eventually succeed; permanent failures do not retry past the first classification; the attempt count, backoff growth and jitter match the policy (assert on timing distribution, not exact values); the per-attempt timeout and overall deadline are honoured; the retry budget caps amplification (a downstream outage must not multiply load); retried operations are idempotent (no duplicates, no double counting, no double spend on a paid API); retries survive a worker crash because their state is in the database; and an item that exceeds its attempts reaches the dead-letter state with the reason recorded.
 
**Circuit breaker behaviour.** Verify: the breaker opens at the configured threshold and not before; while open, calls fail fast without hitting the dependency; the declared degraded mode runs (work queued durably, or enrichment skipped and marked) and no item is dropped or shown with a default as if it were a result; it half-opens after the cool-down with limited probes; it closes only after success and reopens on failure (no flapping); one dependency's breaker does not affect another; the breaker state is visible in telemetry and alerts fire; and the backlog built during the outage drains after recovery faster than new arrivals without causing a second failure.
 
**Permanent failure handling.** Verify dead-letter and quarantine entries carry reason, attempts, last error and timestamps; replay after a fix works, is rate-limited and idempotent; reconciliation totals still balance with dead-lettered items counted; a source that stays unreachable produces a visible coverage gap rather than silence; and operators can see and act on the situation from telemetry alone.
 
**Resilience under load and combination.** Repeat the key scenarios at 800 articles a second, since behaviour at idle proves little (retry storms, pool exhaustion and queue growth only appear under load), and in combination (a scorer outage during a database failover, a backlog during a source burst). Include a recovery test that confirms the system returns to its normal steady state without manual intervention. Run the experiments as scheduled game days with a defined blast radius, a steady-state hypothesis stated first and abort conditions.
 
Where behaviour depends on a threshold (breaker trip rate, attempts, backoff cap), test the configured values and also check that changing them in configuration actually changes the behaviour.
 
### 5. Test levels and placement
 
Assign each test to a level so the fast suite stays fast:
 
- Unit tests for pure logic (normalisation, validation, score scaling).
- Integration tests against a real PostgreSQL (not a mock; partitioning, locking and index behaviour only show up on the real thing), using disposable instances.
- Contract tests for the article schema and for any external scorer or model interface.
- End-to-end pipeline tests for conservation and fidelity on small sets.
- Load, soak and fault-injection tests on a production-like environment, scheduled rather than run on every commit.
State which run on every commit, which nightly, and which on demand before release.
 
### 6. Security and sanity tests
 
Pull the malicious and malformed inputs from the data-sanity spec and assign them to levels. Each has an expected safe outcome: stored intact, flagged, never executed, never dropped.
 
### 7. Exit criteria and reporting
 
Define "done": every invariant holds across the scenario set, every dependency fault in the resilience table behaves as designed (including recovery without manual intervention), every FP has passing coverage or an accepted, recorded gap, every soft requirement has a measured result against its threshold, and results are stored in a consistent report. For statistical claims, run enough repetitions to show variance and report percentiles and spread, not a single run. Say what a failure means for the plan (blocker, risk accepted by whom).
 
### 8. Decisions to put to the user
 
Raise choices that need a human: how aggressive fault injection may be and in which environment, the thresholds beyond the 15-minute target, how long the soak runs, what environment is production-like enough, who accepts a known gap, and the test data policy (synthetic only, or anonymised real samples). Use the protocol in the context file.
 
## Output
 
Write the spec with these sections:
 
1. **Summary and scope**
2. **Test environment and tooling** (current state with paths, recommended additions)
3. **Integrity invariants and tests** (conservation, fidelity, idempotency, ledger, confidence, search completeness)
4. **Failure-point coverage matrix** (FP-n to tests, technique, expected outcome)
5. **Soft requirements** (table: claim, threshold, method, load profile, evidence; agreed versus proposed thresholds marked)
6. **Hot path measurements** (HP-n to measurement and human-inspection trigger)
7. **Load generator and test data specification**
8. **Resilience and negative tests** (table per dependency: fault injected, expected retry, breaker and dead-letter behaviour, degraded mode, evidence; negative-input catalogue; game-day scenarios)
9. **Security and sanity tests**
10. **Test levels and when they run**
11. **Exit criteria and reporting**
12. **Gaps, risks and open questions**
13. **Handoff** (what carma-plan schedules: environment setup, generator, harness, then suites)
## Persisting the work (when run inside a codebase)
 
Follow "Spec conventions" in the context file. Number with `python scripts/next_spec_number.py .specs/testing/backend`, write `.specs/testing/backend/NNNN-<feature-slug>.md` with `spec: carma-backend-testing` front matter and list the architect and DBA specs under `inputs`. Edit in place while `draft`. When the user decides a question that should be binding, suggest recording it as an ADR through carma-architect.
 
If you are not in a codebase, deliver the output in the conversation and offer to save it.