---
spec: carma-devops
number: 0003
title: Deployment delta for article translation
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0013-labelled-mock-fallback-when-key-missing.md, .specs/architect/adrs/0014-observability-stack.md, .specs/architect/adrs/0022-translate-at-ingest-as-enrichment-part.md, .specs/architect/adrs/0023-openai-small-model-chunked-translation.md, .specs/data/dba/0003-article-translation.md, .specs/data/sanitization/0003-article-translation.md, .specs/telemetry/0003-article-translation.md, .specs/devops/0002-json-file-upload.md]
principles: [P2, P3, P6, P7]
supersedes: null
---

# 0003 Deployment delta for article translation

## 1. Summary
No new service, image or secret. `docker compose up` on an existing install rebuilds the app image, the `migrate` job applies `0004_article_translations.sql`, the worker starts a translation lane, and Prometheus/Grafana pick up new alert and dashboard files. New settings are plain configuration with safe defaults. The translation lane reuses the existing `OPENAI_API_KEY`; without a key it runs a clearly labelled mock translator (ADR-0013). One host is enough for the PoC volume; at the 800/s design target translating every foreign article is not feasible on one host or within a sensible LLM budget (section 3), which is the main finding.

## 2. Inputs and current state
- `compose.yaml`: `secrets-init`, `db` (postgres 16.6, `mem_limit 1g`), `migrate` (one-shot, `service_completed_successfully` gate), `seed` (profile), `web`, plus worker, Prometheus and Grafana further down. App services share the `x-app` anchor: `read_only`, `cap_drop: ALL`, `no-new-privileges`, `.env` optional.
- `.env.example` already carries the provider, budget and worker settings: `OPENAI_API_KEY`, `OPENAI_MODEL`, `BUDGET_OPENAI_DAILY=10`, `WORKER_CONCURRENCY_OPENAI=2`, `RPM_OPENAI=60`, `MAX_ATTEMPTS=4`, `CALL_TIMEOUT_MS=30000`, `INPUT_TOKEN_CAP=4000`, `ENRICHMENT_MODE=auto`. Settings are validated by a zod schema in `src/lib/config.ts` (lines 40 to 75, mapped around 255 to 275).
- Migrations run from `MIGRATIONS_DIR=/app/db/migrations` in `migrate`; roles and passwords are managed there (`set_role_password`).
- Observability: `ops/prometheus.yml`, `ops/alerts.yml`, `ops/grafana/provisioning` (devops 0002 added U1 to U5).
- No secrets found in the repository for this feature. `OPENAI_API_KEY` is read from `.env` / environment for the worker, never committed (`.env.example` has it commented out).
- Finding (worker, `src/worker/loop.ts`): the claim cycle holds one pooled connection (`client`) until the end of the `finally`, i.e. across the provider calls of every claimed job, even though the claim transaction is already committed. With translation jobs lasting up to minutes (up to 20 chunks), a held connection per lane would waste connections. Release the client right after `COMMIT` (it is not used afterwards). This is part of the plan.

## 3. Target machine and capacity fit
Target machine: unknown (CPU, memory, disk, OS), UNCONFIRMED (same as devops 0001/0002).

Translation is LLM-bound, not host-bound. Assume `B` = 3 KB body, about 750 input tokens in English or about 1,000 in Arabic, similar output, so about 1.5 to 2k tokens per article, about 2 provider calls per article (1,500-token chunks).
| Scenario | Foreign articles/day | Calls/s | Tokens/day | Fit |
| --- | --- | --- | --- | --- |
| PoC (50,000/day, f = 30%) | 15,000 | 0.35 | about 25 to 30 M | Fits: `RPM_OPENAI`-style limit of 60/min is enough; set the translate lane to 2 workers |
| Design target, f = 10% (800/s) | 6.9 M | about 160 | about 10 to 14 B | Does not fit: far above any default rate limit and any plausible daily budget |
| Design target, f = 30% | 20.7 M | about 480 | about 30 to 40 B | Does not fit |
Postgres load is small by comparison (DBA 0003 section 3). What breaks first at the design target is the provider's rate limit and the budget, not CPU, memory or disk. With ADR-0010 deferral the queue would grow without bound and most foreign articles would sit in `deferred_budget` for days. Consequence for the plan: ADR-0022 (translate everything at ingest) is right for the PoC and should be revisited as hybrid (translate on demand and for recent or prioritised articles, ADR-0022 option 3) before any move toward the 800/s target. Recorded as a risk (FP-V1), not changed here.

Host additions: worker memory rises slightly (chunk buffers; keep `mem_limit` at the current value and re-measure), CPU is negligible (validators are linear text scans). Disk growth for translations is in DBA 0003 (about 75 MB/day at PoC volume).

## 4. Service topology (delta)
| Service | Change |
| --- | --- |
| `db` | No image or extension change. Disk: see DBA 0003. `shm_size` unchanged |
| `migrate` | Applies `0004`. The constraint changes use `NOT VALID` then `VALIDATE` (DBA 0003 section 10), so the one-shot job stays short on large job tables |
| `worker` | Image rebuilt. New translation lane with its own concurrency, rate limit, breaker name `openai-translate` and budget. Env: new variables in section 6. Needs the same `OPENAI_API_KEY` file/env as today. Graceful shutdown: on SIGTERM it stops claiming and lets in-flight chunk calls finish or release the claim (visibility timeout covers a hard kill) |
| `web` | Image rebuilt (article page, search, `POST /api/telemetry/translation-view`). No new secret. Needs read access to `article_translations` through the existing `app_read` role |
| `prometheus`, `grafana` | Mount updated `ops/alerts.yml` (T1 to T8) and a new dashboard JSON row. No new container |
| `secrets-init` | No change |
There is no network or port change. The beacon route is served by `web` on the existing port.

## 5. Zero-touch bring-up sequence
Same as today; the new steps are inside existing gates.
1. `secrets-init` (unchanged) then `db` healthy.
2. `migrate` runs migrations in order, including `0004`; it is idempotent (`IF NOT EXISTS`, constraint swap guarded by catalog lookups) and writes `system_flags` `translation_enabled` (from `TRANSLATION_ENABLED`, default true) next to `enrichment_enabled`.
3. `worker` and `web` start only after `migrate` completes; `web` readiness (`/api/health`) additionally checks that `article_translations` exists, so a code/schema mismatch fails readiness instead of failing on first article view.
4. Worker readiness: it can claim a job of each part; the translation lane starts in "mock" or "real" mode and logs which, once, at startup (`translation.provider_mode`), and exposes it in `/api/status`.
5. Prometheus loads rules; Grafana provisions the dashboard. If a rules file is invalid, Prometheus exits with a clear message (checked in CI with `promtool check rules`).
Validation at startup (zod): an out-of-range value stops the process with the variable name and the allowed range.

## 6. Configuration and secrets
No new secrets. `OPENAI_API_KEY` is the existing external secret (supplied via `.env`; failure behaviour as ADR-0013).
| Name | Purpose | Default | Secret | Provided by | Rotation / restart |
| --- | --- | --- | --- | --- | --- |
| `TRANSLATION_ENABLED` | Seed value of the `translation_enabled` flag; the flag itself is the live kill switch | `true` | No | `.env`, then flag via SQL | flag is read each loop, no restart; flip with `UPDATE system_flags` |
| `TRANSLATE_MODEL` | Model id for translation | falls back to `OPENAI_MODEL` | No | `.env` | restart worker; recorded per row (P7) |
| `WORKER_CONCURRENCY_TRANSLATE` | In-flight translation jobs | `2` | No | `.env` | restart worker |
| `RPM_TRANSLATE` | Request cap for the lane | `60` | No | `.env` | restart worker |
| `BUDGET_TRANSLATE_DAILY` | Daily cap for translation, in `BUDGET_CURRENCY` (separate ledger key `openai-translate`; additive to `BUDGET_OPENAI_DAILY`, total up to 13, ADR-0029) | `3` | No | `.env` | restart worker |
| `TRANSLATE_CHUNK_TOKENS` | Estimated tokens per chunk | `1500` | No | `.env` | restart worker; changes `prompt_version` suffix so cache keys differ |
| `TRANSLATE_MAX_CHUNKS` | Hard cap per article; beyond it the job is dead `too_long` | `20` | No | `.env` | restart worker |
| `TRANSLATE_RATIO_CJK`, `TRANSLATE_RATIO_OTHER` | Output/input length bounds, "min,max" | `0.15,Infinity` and `0.3,3.0` | No | `.env` | restart worker |
| `TRANSLATE_CACHE_DAYS` | Chunk cache retention after job end | `7` | No | `.env` | sweeper reads each run |
| `TRANSLATE_SUPERSEDED_DAYS` | Retention of superseded translations | `30` | No | `.env` | sweeper reads each run |
| `TRANSLATE_PROMPT_VERSION` | Prompt id, recorded on every row | `t1` | No | `.env` | restart worker |
Provider prices reuse `OPENAI_PRICE_IN_PER_MTOK` and `OPENAI_PRICE_OUT_PER_MTOK`. When prices are unset the existing behaviour applies (estimated cost flagged; budget placeholder), unchanged.
Rules kept: no setting is baked into an image; `.env.example` gets the lines above commented with defaults; values are validated in `src/lib/config.ts`; the translation text and the key never appear in logs (telemetry 0003 section 5).

### Mock translator (no key, ADR-0013)
- `ENRICHMENT_MODE=auto` with no `OPENAI_API_KEY`: the translation lane uses the mock. In `real` mode a missing key fails fast at startup, as for the other parts.
- The mock must not pass as a real translation. Rows get `enrichments.origin = 'mock'`, `provider = 'mock'`; the output starts each paragraph with `[mock translation]` followed by deterministic Latin placeholder words of about the source length, so it differs from the input, passes the language, echo and ratio checks, and keeps the paragraph count. For the bundled sample articles a small fixture lexicon (same idea as the existing mock adapter, `src/lib/providers/mock.ts`) supplies readable English so graders can see the feature.
- UI: origin `mock` replaces the bar label with "Mock translation (no translation service configured)", and the "About this" panel says no external call was made. Search treats it like any translation, so it is searchable, but `matched_in` markers say "Matched in translation (mock)".
- Mock latency uses `MOCK_LATENCY_MS`; no budget is consumed (cost 0, `origin` mock), so grader runs never hit `deferred_budget`.

## 7. Deployment, upgrade, rollback and recovery
Upgrade from the current release (with data):
1. `git pull`, `docker compose build`.
2. `docker compose up -d`: `migrate` runs `0004`; `web` and `worker` restart on the new image. Ingestion through the web upload route pauses for the few seconds of the web restart; the upload endpoint is idempotent (devops 0002) and reconciliation shows no loss.
3. Existing foreign articles get no translation job (no backfill, ADR-0028). They stay searchable by original terms; the search page's untranslated note counts them.
4. Verify: `/api/status` shows `translation` counts; open a foreign article; the dashboard row shows jobs moving.
Rollback:
- Fast stop without code change: `UPDATE system_flags SET value='false' WHERE key='translation_enabled'` (worker stops claiming; existing translations still display).
- Code rollback: redeploy the previous image. The old code ignores `translation` jobs, but the old worker's `claimJobs` filters by part, so they stay queued harmlessly; the new `ingest_new_version` signature breaks the old web image (it calls the old signature), so roll back web and worker together and run the DBA rollback script if the old signature must come back (DBA 0003 section 10).
- Data rollback: DBA rollback section; originals are untouched, so nothing is lost.
Backup/restore: `article_translations` is in the normal database backup; no extra step. Restore test checks translation counts and that the current-row unique index holds. Translations are re-creatable but cost money, so they are not excluded from backups.
Recovery after the provider is down: jobs go `failed_retryable` with backoff, the `openai-translate` breaker opens, jobs wait durably; on recovery the lane drains at `RPM_TRANSLATE` so catch-up cannot overwhelm the provider or the budget.

## 8. Host and platform settings
- Log rotation already set (`json-file`, 10 MB x 3). Translation adds few log lines (telemetry 0003 section 11); no change.
- Clock: translation lag SLO uses `ingested_at`, which is the database clock; no new dependency.
- Outbound network: the worker needs HTTPS to `api.openai.com` as today; if the host is offline, jobs stay queued, the breaker opens, and the mock mode (if selected) is the only offline option.
- DB pool: the worker's pool gets one more concurrent lane. After releasing the claim connection early (section 2) each lane holds a DB connection only for claim, save and cache writes. Set the worker pool max to at least `jev + openai + translate` concurrency plus 2; check the current value in `src/lib/db/pool.ts` before changing (UNCONFIRMED).

## 9. Deployment test plan
| Test | Proves | How | Pass |
| --- | --- | --- | --- |
| Clean bring-up | Zero-touch with migration `0004` | Fresh volumes, `docker compose up -d` with no `.env` | All healthy; `article_translations` exists; sample foreign articles get mock translations; `/api/status` shows `provider_mode=mock` |
| Real-key smoke | Real path | `.env` with a key and a small `BUDGET_TRANSLATE_DAILY`, upload `sample_articles.json` | Foreign articles translated (origin `provider`); spend recorded under `openai-translate`; page shows translation by default and the original on click |
| Idempotent restart | Re-run safe | `down` then `up`; `up` twice | Migration re-applies cleanly; no duplicate translations; jobs unchanged |
| Upgrade with data | `0004` on existing data | Start the previous release, load articles and results, upgrade | Existing articles, jobs, enrichments intact; new jobs for new foreign articles; search on originals unchanged |
| Constraint migration lock | FP-DB3 | Run `0004` against 1M `enrichment_jobs` rows while inserting | Insert stalls under 1 s |
| Kill switch | Operations | Set `translation_enabled=false`; upload foreign article | Job stays queued; page shows "Translation in progress"; flip back, it drains |
| Missing key, `auto` | ADR-0013 | No `OPENAI_API_KEY` | Mock lane, labelled everywhere; no outbound calls (check with egress block) |
| Missing key, `real` | Fast clear failure | `ENRICHMENT_MODE=real`, no key | Worker exits with a message naming `OPENAI_API_KEY` |
| Provider down | Resilience | Block egress to the provider for 10 min | Breaker `openai-translate` opens; sentiment and summaries unaffected; jobs resume after unblocking; alert T1 fires |
| Budget exhausted | ADR-0010 | `BUDGET_TRANSLATE_DAILY=0.01` | Jobs `deferred_budget`; summary lane unaffected; page shows the paused message |
| Worker crash mid-article | P2 | `docker kill` worker during a 15-chunk article | Claim expires, retry reuses cached chunks, exactly one current translation |
| Connection use | Section 2 finding | 2 long translations plus normal load; watch `pg_stat_activity` | Worker connections stay below pool max; none idle in transaction |
| Secret exposure | No leaks | `docker inspect`, `docker compose config`, log grep for the key and for sample article text | Key absent; no article text in logs |
| Alert and dashboard provisioning | Observability | `promtool check rules ops/alerts.yml`; open Grafana | Rules valid; row "Translation" present, no manual import |
| Capacity | Fit | PoC load with 30% foreign and the mock lane at 0 latency | Postgres CPU/IO within limits; translation lane keeps up |

## 10. Repository artefacts to create or change
- `db/migrations/0004_article_translations.sql` (DBA 0003).
- `src/lib/config.ts` and `.env.example` (section 6), `compose.yaml` (worker env lines), `compose.dev.yaml` if it duplicates worker env.
- `ops/alerts.yml` (T1 to T8), `ops/grafana/provisioning/dashboards/*.json` (translation row), `ops/prometheus.yml` only if a new job is needed (none).
- `src/worker/*` (translation lane, early release of the claim connection), `src/lib/providers/*` (translate adapter and mock). No backfill CLI (ADR-0028).
- `README.md` / `docs/environment.md`: one paragraph on translation settings, mock mode, kill switch and rollback.
- CI: add `promtool check rules` and the clean-bring-up test to the existing pipeline if one exists (none found in the repository; UNCONFIRMED).

## 11. Risks and hot paths
| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-V1 | At the 800/s target, translating all foreign articles exceeds provider rate and budget | Permanent backlog, English search misses most foreign articles | P3 | Queue age, deferral counts (T1/T2); decision before scale-up |
| FP-V2 | Mock output mistaken for real translation | Readers trust placeholder text | P6, P7 | Origin `mock` label on page, `provider_mode` in status |
| FP-V3 | Worker holds a DB connection during long translations | Pool exhaustion, claims stall | P2 | Pool gauge, connection test |
| FP-V4 | Web and worker roll back separately across the `ingest_new_version` signature change | Upload route errors | P2 | Rollback instruction, smoke test after rollback |
| FP-V5 | Translation spend competes with summary spend | Core enrichment paused | P3 | Separate ledger key and cap |
| FP-V6 | `real` mode start with no key succeeds silently | No translation, no clue | P3 | Startup validation test |
| HP-V1 | Translation lane CPU for validators on long CJK text | Worker CPU | measure ms per 100 KB (HP-D1) |
| HP-V2 | Chunk cache writes | Small writes per chunk | measure with the crash test |

## 12. Handoff
- carma-backend-testing: reuse the Compose test environment; add the mock translator as the deterministic path and the failure-injection hooks (provider down, bad output) at the provider seam.
- carma-plan: order of work: migration and config first, worker connection fix, provider and mock, validators, then web.

## 13. Decisions needed and open questions
- Target hardware unknown. UNCONFIRMED.
- Whether to revisit ADR-0022 for any scale beyond the PoC (FP-V1): not needed now; flag for the user if the 800/s target becomes real.
- Translate-lane budget: default `3` (30% of the OpenAI cap) is a placeholder until prices are known.
- Backfill: decided no (ADR-0028).
- Worker pool max: check the current value.
