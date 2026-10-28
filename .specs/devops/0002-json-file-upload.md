---
spec: carma-devops
number: 0002
title: Deployment delta for the JSON upload
status: draft
date: 2026-10-24
feature: json-file-upload
inputs: [.specs/architect/0002-json-file-upload.md, .specs/data/sanitization/0002-json-file-upload.md, .specs/data/dba/0002-json-file-upload.md, .specs/telemetry/0002-json-file-upload.md, .specs/devops/0001-media-signal-service.md, .specs/architect/adrs/0019-upload-route-uses-ingest-pool-synchronous.md, .specs/architect/adrs/0020-upload-endpoint-shared-token.md]
principles: [P2, P3]
supersedes: null
---

# 0002 Deployment delta for the JSON upload

## 1. Summary
No new services. `docker compose up` still brings everything up; the delta is: two secrets mounted into `web` (the ingest DB password and the upload token), five new settings with safe defaults, a larger `web` memory limit, and migration `0003` applied by the existing `migrate` job. One host remains enough: an upload is at most 5 MiB and 1000 items and runs one at a time.

## 2. Inputs and current state
- `compose.yaml`: `web` runs `ROLE=web` with `DB_PASSWORD_FILE=/run/secrets/app_read_password`, `mem_limit: 384m`, `tmpfs: [/tmp, /app/.next/cache]`, `read_only` and `cap_drop: ALL` through the `x-app` anchor, published on `${WEB_BIND:-127.0.0.1}` (loopback by default, so the upload endpoint is not exposed to the network unless the operator changes it).
- `ops/init-secrets.sh` generates secrets into `.master` and copies per-service files; `web` receives only `app_read_password` and `cursor_secret`; `app_ingest_password` goes to `migrate` and `seed` only.
- `.env.example` holds placeholders only; no committed secrets found in the files read. No reverse proxy exists (the web container is the edge).
- `migrate` applies `db/migrations/*.sql` on every `up` (idempotent), then web and worker wait on `service_completed_successfully`.

## 3. Target machine and capacity fit
Unchanged from 0001. Upload memory: a 5 MiB body held as a buffer, a decoded string (up to 2x for non-ASCII, JS strings are UTF-16), and the parsed array (several times the text size) is roughly 40 to 60 MB peak, on top of Next.js baseline (about 150 to 200 MB, to be measured). The current `mem_limit: 384m` is therefore marginal. Recommend **512m** for web (UNCONFIRMED until HP-2 is measured). DB side: at most 1000 transactions per upload, no capacity concern.

## 4. Service topology (delta)
| Service | Change |
| --- | --- |
| `secrets-init` | Generate `app_ingest_password` (exists) and new `upload_token`; copy both into `$ROOT/web`; `secure_tree` already sets ownership to the node UID |
| `web` | Add env `INGEST_DB_PASSWORD_FILE=/run/secrets/app_ingest_password`, `UPLOAD_TOKEN_FILE=/run/secrets/upload_token`, `UPLOAD_ENABLED`, `UPLOAD_MAX_BYTES`, `UPLOAD_MAX_ITEMS`, `INGEST_STATEMENT_TIMEOUT_MS`, `UPLOAD_DEADLINE_MS`; `mem_limit: 512m`; keep `read_only`, `tmpfs /tmp` (size-limit it, e.g. 64m, in case a multipart parser spools to disk) |
| `migrate` | Unchanged command; now also applies `0003_article_versions.sql` |
| `worker` | Image rebuilt (version-aware code); no new secret |
| `db` | No change; no new extension |
| `prometheus`/`grafana` | Mount updated `ops/alerts.yml` (U1 to U5) and dashboard JSON; no new container |

The `web` container now holds two database credentials (`app_read` for reads, `app_ingest` for the upload route only), which is the privilege widening accepted in ADR-0019. Keep the ingest password out of the `x-app` shared environment; put it only on `web`.

## 5. Zero-touch bring-up sequence
Unchanged order: `secrets-init` then `db` healthy then `migrate` (now runs 0003, which also grants EXECUTE on the two new functions to `app_ingest`/`app_read` and replaces `status_snapshot()`) then `web` and `worker`. New readiness rule: `readyz` stays about DB reachability and migrations; upload health is reported separately in `/api/status` (`upload: {enabled, token_configured, ingest_pool_ok}`) and does not block the web healthcheck, so a missing token disables only the upload (503 `upload_disabled`), never the whole app. Restart over existing data: migration is idempotent (DBA 0002 section 10).

## 6. Configuration and secrets
| Name | Purpose | Default | Secret | Provided by | Rotation |
| --- | --- | --- | --- | --- | --- |
| `UPLOAD_TOKEN_FILE` (`upload_token`) | Shared bearer token (ADR-0020) | generated, 40 chars | Yes | `secrets-init` | Delete `.master/upload_token`, run `docker compose up -d secrets-init web`; new token printed? **No**: operator reads it from the volume with a documented one-liner (`docker compose run --rm secrets-init cat /secrets/.master/upload_token`); web restarts |
| `INGEST_DB_PASSWORD_FILE` | `app_ingest` password for the upload pool | existing generated secret | Yes | `secrets-init` | Existing rotation: re-run `migrate` (it calls `set_role_password`), restart `web` and `seed` |
| `UPLOAD_ENABLED` | Kill switch | `true` | No | `.env` | restart `web` |
| `UPLOAD_MAX_BYTES` | Body cap | `5242880` | No | `.env` | restart `web` |
| `UPLOAD_MAX_ITEMS` | Item cap | `1000` | No | `.env` | restart `web` |
| `INGEST_STATEMENT_TIMEOUT_MS` | Pool `statement_timeout` | `10000` | No | `.env` | restart `web` |
| `UPLOAD_DEADLINE_MS` | Overall request deadline | `60000` | No | `.env` | restart `web` |
Validation at start (extend `src/lib/config.ts`): numbers positive, `UPLOAD_MAX_BYTES` at most 25 MiB (hard ceiling vs memory limit), token at least 32 characters; if `UPLOAD_ENABLED=true` and the token file is missing or short, the route reports `upload_disabled` and `/api/status` says why, with a logged one-line fix. Rules unchanged: no secret in env dumps or `docker inspect` (files, not env); `.env.example` gets the five non-secret settings with comments, never a token. Pino redaction extended (telemetry 0002 section 5). The token is shown to the operator only by reading the volume; it is never printed in logs by `secrets-init` (existing script prints only "generated <name>").

## 7. Deployment, upgrade, rollback and recovery
- **Upgrade N to N+1 (expand/contract).** 0003 is additive (new columns with constant defaults, new table, new functions, constraint swap on two small tables). Old web/worker code keep working on the new schema except: the old worker would write `enrichments` without `article_version` (default 1) and could attach a result to a changed article. Therefore deploy order is: stop worker, run `migrate`, start new web and worker together (`docker compose up -d --build` does this); versioning cannot occur before the new web exists, so the window is safe.
- **Rollback.** Images and config: yes. Migration: per DBA 0002 section 10; versions beyond 1 would be lost from `articles` if the code is rolled back after changed re-uploads (`article_versions` keeps them). State this in the migration header and the upgrade notes.
- **Body limits.** There is no reverse proxy; the Next server enforces the app-level cap (`Content-Length` check plus counting bytes read). If a proxy is added later it must allow at least `UPLOAD_MAX_BYTES` plus multipart overhead (set 6 MiB) and a read timeout above `UPLOAD_DEADLINE_MS`. Check Next's own body-size behaviour for route handlers in `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` before relying on defaults (architect open question).
- **Backup/restore:** unchanged; `article_versions` is included in the dump automatically.

## 8. Host and platform settings
Unchanged. Container logs already rotate (`json-file` 10m x 3). `/tmp` tmpfs size-limited. Clock sync matters for `published_at` validation (future-dated check uses server `now`).

## 9. Deployment test plan
| Test | Proves | How | Pass |
| --- | --- | --- | --- |
| Clean bring-up | Zero-touch with new secrets | Fresh volumes, `docker compose up -d`, wait healthy | All healthy; `upload_token` exists in `web` mount only; `/api/status` shows upload enabled |
| Smoke upload | End to end | `curl -H "Authorization: Bearer $(token)" -F file=@sample_articles.json /api/uploads`, then poll batch | `reconciled=true`, 20 received; enrichment reaches terminal states; search finds them |
| Idempotent restart | Re-run safe | `down` then `up`; repeat upload | 0 new rows; migration re-applies cleanly |
| Missing token | Clear failure | Remove `upload_token`, restart web | Upload returns 503 `upload_disabled`; rest of app healthy; clear log line |
| Wrong/no token | Auth | curl without/with bad token | 401, nothing stored |
| Secret exposure | No leaks | `docker inspect web`, `docker compose config`, image layer scan, log grep for token | token absent |
| Credential scope | ADR-0019 boundary | From web container as `app_read`: attempt INSERT; as `app_ingest`: attempt UPDATE articles | both denied |
| Memory | Limit adequate | 5 MiB / 1000-item file at the cap while sampling `docker stats` | peak below 80% of limit, no OOM kill (HP-2) |
| Kill and restart web mid-upload | Recovery | Kill during a 1000-item upload; re-upload | Stored items reported as duplicates; counts reconcile |
| DB down | 503 handling | Stop `db` during upload | 503 `db_unavailable`, `Retry-After`, recovers after start |
| Upgrade with data | Migration 0003 on existing data | Start 0001-schema stack with data, upgrade | Articles intact, version=1, jobs readable, search unchanged |
| Config validation | Bad values rejected | `UPLOAD_MAX_BYTES=0`, `UPLOAD_MAX_BYTES=100000000` | Startup warning/error naming the setting |
| CI | Regression | Compose validate, secret scan, smoke upload in CI | green |

## 10. Repository artefacts to create
`db/migrations/0003_article_versions.sql`; changes to `compose.yaml` (web env, memory, tmpfs size), `compose.dev.yaml` (matching dev values), `ops/init-secrets.sh` (upload token, copy to web), `.env.example` (five settings), `src/lib/config.ts` (new settings and validation), `ops/alerts.yml`, `ops/grafana/*`, README section "Uploading articles" (how to read the token, limits, rollback note).

## 11. Risks and hot paths
| ID | Entry | Detail |
| --- | --- | --- |
| FP-V1 | Web OOM during a large upload | Container killed mid-request; items already committed; mitigated by 512m, byte cap, re-upload idempotency |
| FP-V2 | Token secret missing or stale after rotation | Upload disabled or 401; clear status message |
| FP-V3 | Ingest password rotated but web not restarted | Upload 503 `db_unavailable` with auth error; runbook step |
| FP-V4 | `/api/uploads` exposed beyond loopback by changing `WEB_BIND` | Token is the only protection; document, and U5 alert |
| FP-V5 | Old worker running against new schema | Wrong-version enrichment; mitigated by deploy order |
| HP-V1 | Web memory under peak upload plus search traffic | Measure with `docker stats` during the benchmark |

## 12. Handoff
carma-backend-testing: reuse this Compose stack (smoke, idempotency, credential scope, DB-down, kill-mid-upload tests above). carma-plan: tasks in section 10, deploy order in section 7.

## 13. Decisions needed and open questions
- CONFIRMED: web `mem_limit` 512m; `/tmp` tmpfs 64m; `UPLOAD_MAX_BYTES` ceiling 25 MiB.
- Open: whether the operator should be shown the token somewhere other than the volume (e.g. a README command only). Default: README command.

### Spike: Next.js Route Handler body handling (2026-10-24, Next 16.4.3)

Sources: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (Request Body / FormData); Server Actions `bodySizeLimit` docs; Pages Router `bodyParser.sizeLimit` docs.

Findings:
1. **App Router Route Handlers have no documented default body size limit.** Unlike Server Actions (1 MB default, configurable via `serverActions.bodySizeLimit`) and Pages API routes (`bodyParser.sizeLimit`), Route Handlers expose the Web `Request` API with no Next-level size gate documented.
2. **`request.json()`, `request.text()`, `request.arrayBuffer()`, and `request.formData()` all buffer the full body in memory** before the handler proceeds. There is no streaming form of `formData()`.
3. **`Content-Length` alone is not trustworthy** (can under-declare, or be absent on chunked transfer). Over-declaration can still be used as a fast reject.
4. **How we enforce `UPLOAD_MAX_BYTES` on bytes read:** (a) if `Content-Length` is present and greater than the cap → 413 before reading; (b) read the body with `request.body.getReader()`, accumulate into a `Uint8Array` while counting, abort with 413 as soon as the count exceeds the cap; (c) for `multipart/form-data`, reject on oversize `Content-Length` first, then `formData()`, then check the `file` Blob `.size` (post-buffer check — acceptable because Cap is 5 MiB and web mem is 512m); (d) never call `request.json()` on untrusted size. Peak RSS for a 5 MiB JSON body is roughly buffer + UTF-16 string + parsed array (~40–60 MB) on top of Next baseline — within 512m.

Measurement note: full RSS sampling of 6 MiB / 30 MiB against a live Next process is deferred to phase-2 HP-2 (`reports/json-file-upload/`); the enforcement design above does not depend on a Next built-in limit.
