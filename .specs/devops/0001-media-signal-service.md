---
spec: carma-devops
number: 0001
title: Docker Compose deployment, secrets and test plan for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/data/dba/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
  - .specs/telemetry/0001-media-signal-service.md
  - .specs/search/0001-media-signal-service.md
  - .specs/ux/0001-media-signal-service.md
principles: [P1, P2, P3, P6, P7]
supersedes: null
---

# Deployment

## 1. Summary

From a clean clone, `docker compose up --build` produces a working system with no manual steps and no files to create:

1. internal secrets are generated into a volume,
2. PostgreSQL starts and reports healthy,
3. the migrator creates roles, extensions, tables, indexes and grants,
4. the sample 20 articles are loaded and queued for enrichment,
5. the web app (http://localhost:3000) and the worker start,
6. with no API keys the worker runs in a clearly labelled mock mode; with keys in `.env` it calls jev and OpenAI.

One host is more than enough for the assignment (50,000 articles a day is 0.58 a second). For the 800/s growth path one host stops being enough on disk volume, trigram index maintenance and provider concurrency, not on CPU (section 3).

The environment this was written for: Windows 11 with Docker 27.2.0 and Compose v2.29.2 (Docker Desktop), Node 22.14.0, npm 11.16.0 (checked 2026-10-24). That means Linux containers in a WSL2 virtual machine; section 8 lists the Windows-specific traps (line endings, bind mounts, clock drift).

## 2. Inputs and current state

- Greenfield: no Dockerfile, Compose file, CI configuration, `.dockerignore`, `.env`, scripts or committed secrets exist. The repository root `D:\Dev\Carma\interview` has only `.specs/` and is not a git repository yet (`git init` is the first task, and `.gitignore` must exist before the first commit).
- Findings: none. No secret is committed. The first commit must include `.gitignore` entries for `.env*` (except `.env.example`), `secrets/`, `backups/`, `node_modules/`, `.next/`.
- Facts used from other specs: Debian-based Postgres image with the major pinned, `shared_preload_libraries=pg_stat_statements`, settings in DBA section 10; roles `app_ingest`, `app_worker`, `app_read` plus a bootstrap superuser used only by the migrator; keys only in the worker; readiness never depends on providers (telemetry section 9); optional `observability` profile; kill switch in `system_flags`.

## 3. Target machine and capacity fit

**Target:** the user's Windows 11 machine via Docker Desktop, and graders' machines of unknown type. CPU, RAM and disk of the host are unknown (`UNCONFIRMED`). Assumed minimum: 2 CPUs, 4 GB RAM available to Docker, 5 GB free disk, internet access for image pulls and for real-provider calls. Offline mode works only if the images are already pulled and the stack runs in mock mode.

**Memory budget (default, `DB_TUNING=small`):**

| Service | Limit | Typical use |
| --- | --- | --- |
| db | 1 GB (shared_buffers 256 MB) | 150 to 300 MB |
| web | 384 MB | 120 to 200 MB |
| worker | 256 MB | 80 to 120 MB |
| one-shots (secrets-init, migrate, seed) | 256 MB each, short-lived | n/a |
| Optional: prometheus 256 MB, grafana 256 MB | only with `--profile observability` | n/a |

Total about 1.7 GB running, 2.2 GB with observability. Fits in the default Docker Desktop allocation on a 8 GB machine.

**50,000 articles a day.**

- Database: 0.58 inserts/s average (peak about 6/s), about 5 child rows/s, about 3 job updates/s. Storage 0.5 to 0.7 GB a day (DBA section 3), 180 to 260 GB a year with no retention; irrelevant for the exercise, relevant if the stack is left running.
- Provider capacity per provider: calls = 50,000/day = 0.58/s average, 6/s at 10x peak. With concurrency 4 and 2 s per call, one provider handles 2 calls/s. Headroom is 3.4x on average; a 10x peak makes the queue grow for a while and then drain. Time to drain after a one-hour peak at 6/s (21,600 articles) with 2/s throughput: backlog grows 4/s for the hour (14,400 jobs) and drains at about 1.4/s net in roughly 2.8 hours. That is a fact for the README, not a defect.
- Cost: unknown until prices are supplied (open question). The budget guard makes it bounded regardless.

**800 articles a second (growth path), what would not fit one host:**

- **Disk:** about 700 to 970 GB a day with the current index set. A single host disk is exhausted in days. First fix is architectural (drop the duplicate `search_text`, restrict the trigram index), then retention by partition drop.
- **Write path:** 8 indexes per article including a trigram GIN over about 3 KB of text, and about 4,800 job updates a second. This is the likely first CPU and I/O limit. Docker Desktop's virtualised disk makes any measurement on a Windows host unreliable for this question; measure on Linux with NVMe storage (DBA E5).
- **Providers:** 800 articles/s x 2 calls = 1,600 calls/s. At 2 s per call that is 3,200 calls in flight, far above typical provider rate limits, and the spend would be very large. The data-sanity spec's tiering (cheap checks first, model for a subset) is a requirement at that scale, not an optimisation.
- **Compose limits:** no high availability (one database, one host), no rolling restarts of the database, no replica for search reads. Compose is the wrong tool when a second database host or failover is required; that is the point to move to an orchestrator or managed Postgres. This spec does not plan that move.

## 4. Service topology

| Service | Purpose | Image | Ports | Volumes | Depends on | Healthcheck | Limits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `secrets-init` | One-shot: generate internal secrets if absent | `alpine:3.20` (pin exact) | none | `secrets` (rw), `ops/init-secrets.sh` (ro) | none | exit code | 64 MB |
| `db` | PostgreSQL, extensions, tuning from file | `postgres:16-bookworm` (pin exact minor and digest at build) | none published by default | `pgdata`, `secrets/db` (ro subpath), tuning conf (ro) | secrets-init completed | `pg_isready -h 127.0.0.1` (TCP) | 1 GB, `shm_size` 256 MB |
| `migrate` | One-shot: migrations, roles, extensions, capabilities | `media-signal-app` | none | `secrets/migrate` (ro) | db healthy, secrets-init completed | exit code | 256 MB |
| `seed` | One-shot: load sample articles (idempotent); also the entry point for later loads and replays | `media-signal-app` | none | `secrets/seed` (ro), `data/` (ro) | migrate completed | exit code | 256 MB |
| `web` | Next.js app, API and UI | `media-signal-app` | `127.0.0.1:${WEB_PORT:-3000}:3000` | `secrets/web` (ro); tmpfs `/tmp`, `.next/cache` | migrate completed, db healthy | `GET /api/readyz` via `node -e fetch` | 384 MB |
| `worker` | Enrichment loop, sweeper, ledger gauges, `/metrics` | `media-signal-app` | none (9101 internal) | `secrets/worker` (ro); tmpfs `/tmp` | migrate completed | `GET :9101/healthz` | 256 MB |
| `prometheus`, `grafana` | Optional profile `observability` | pinned upstream images | `127.0.0.1:9090`, `127.0.0.1:3001` | provisioning files from `ops/` | web, worker | HTTP | 256 MB each |
| `backup` | Optional profile `backup`: `pg_dump -Fc` to `./backups` | `postgres:16-bookworm` | none | `./backups`, secrets (ro) | db healthy | exit code | 256 MB |
| `test`, `bench` | Optional profiles: integration tests, disposable-database benchmark | `media-signal-app` | none | as needed | db healthy, migrate completed | exit code | 512 MB |

The application image is built once (`media-signal-app`) and used for web, worker, migrate, seed, test and bench with different commands.

**Networks.**

```
edge  (default bridge, outbound allowed)   : web (published port), worker (provider calls)
data  (internal: true, no internet access) : db, migrate, seed, web, worker, backup, test, bench
```

The database is attached only to `data`, so it is unreachable from the host and cannot reach the internet. The web app is on both networks (the published port needs a non-internal network); the worker is on both (it calls jev and OpenAI). A `compose.dev.yaml` override publishes the database on `127.0.0.1:5432` for local debugging only.

**Illustrative Compose sketch** (not final; shows the shape and the non-obvious settings):

```yaml
name: media-signal
x-logging: &logging
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
x-app: &app
  image: media-signal-app:local
  build: { context: ., target: runner }
  init: true
  read_only: true
  cap_drop: [ALL]
  security_opt: ["no-new-privileges:true"]
  logging: *logging
  env_file:
    - path: .env
      required: false          # zero-touch: the file is optional
  networks: [data]
services:
  secrets-init:
    image: alpine:3.20
    volumes: [ "secrets:/secrets", "./ops/init-secrets.sh:/init.sh:ro" ]
    command: ["sh", "/init.sh"]
    restart: "no"
  db:
    image: postgres:16-bookworm
    depends_on: { secrets-init: { condition: service_completed_successfully } }
    environment:
      POSTGRES_USER: mss_admin
      POSTGRES_DB: ${DB_NAME:-mss}
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    command: ["postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"]
    volumes:
      - pgdata:/var/lib/postgresql/data
      - { type: volume, source: secrets, target: /run/secrets, read_only: true, volume: { subpath: db } }
      - ./db/postgres/${DB_TUNING:-small}.conf:/etc/postgresql/postgresql.conf:ro
    shm_size: 256mb
    mem_limit: 1g
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U mss_admin -d ${DB_NAME:-mss}"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
    restart: unless-stopped
    networks: [data]
  migrate:
    <<: *app
    command: ["node", "dist/cli/migrate.js"]
    depends_on:
      db: { condition: service_healthy }
      secrets-init: { condition: service_completed_successfully }
    restart: "no"
  seed:
    <<: *app
    command: ["node", "dist/cli/load.js", "--file", "/data/sample_articles.json", "--kind", "backfill"]
    depends_on: { migrate: { condition: service_completed_successfully } }
    restart: "no"
  web:
    <<: *app
    command: ["node", "server.js"]
    ports: ["${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}:3000"]
    networks: [data, edge]
    tmpfs: [ /tmp, /app/.next/cache ]
    depends_on: { migrate: { condition: service_completed_successfully } }
    restart: on-failure:5
  worker:
    <<: *app
    command: ["node", "dist/worker.js"]
    networks: [data, edge]
    stop_grace_period: 40s
    depends_on: { migrate: { condition: service_completed_successfully } }
    restart: on-failure:5
    # provider keys come from .env (OPENAI_API_KEY, JEV_API_KEY), only for this service
volumes: { pgdata: {}, secrets: {} }
networks: { edge: {}, data: { internal: true } }
```

Notes on the sketch: `subpath` volume mounts need Docker Engine 26+ and Compose 2.26+ (present here, verify on Docker Desktop, `UNCONFIRMED`); `env_file` with `required: false` needs Compose 2.24+; the `config_file` override must set `listen_addresses = '*'` or other containers cannot connect (DBA settings file must include it).

## 5. Zero-touch bring-up sequence

| Step | What happens | Readiness gate |
| --- | --- | --- |
| 1 | `secrets-init` writes `/secrets/.master/*` if absent (40-character random values from `/dev/urandom`), then copies each consumer's files into `/secrets/<consumer>/`. Never overwrites an existing master value | Exits 0 |
| 2 | `db` starts; first run runs `initdb` with `POSTGRES_PASSWORD_FILE` | `pg_isready -h 127.0.0.1` succeeds. **TCP, not the socket:** the official image starts a temporary server on the Unix socket only while initialising, so a socket-based check can pass before initialisation is complete |
| 3 | `migrate` takes `pg_advisory_lock`, applies pending SQL migrations (roles, `pg_trgm`/`unaccent`/`pg_stat_statements`, tables, indexes, grants), sets role passwords from the secret files through `set_role_password`, records capabilities (`trgm_index=on/off`), seeds `system_flags` (`enrichment_enabled` from `ENRICHMENT_ENABLED`) | Exits 0; a failure prints the cause and stops the stack |
| 4 | `seed` loads `sample_articles.json` through the same validate-sanitise-insert path; ledger shows `received 20 = admitted 20`; jobs queued | Exits 0 |
| 5 | `web` starts, validates configuration, connects as `app_read` | `/api/readyz` returns 200: database reachable, latest migration applied |
| 6 | `worker` starts, validates configuration, selects per-provider mode, begins claiming jobs, writes heartbeat | `/healthz` heartbeat within 60 s |
| 7 | Optional: observability profile | Prometheus targets up; Grafana provisioned |

**Idempotency.** Steps 1, 3 and 4 are safe to repeat: secrets are never overwritten; migrations are tracked by name and checksum; the seed uses `ON CONFLICT (source, external_id) DO NOTHING` and records duplicates in the ledger. A second `up` finds `pgdata` populated, skips `initdb`, and re-runs migrate and seed as no-ops. A reboot with `restart: unless-stopped` on `db` and `on-failure` on the app services brings the stack back; the Compose project itself is started by Docker Desktop's "start on login" or `docker compose up -d` (a systemd unit on Linux).

**Fast, clear failure.** Configuration is parsed once per process by a shared schema; on error the process prints a message and exits non-zero:
`Configuration error: OPENAI_MODEL is required when OPENAI_API_KEY is set. Add it to .env (see .env.example).`
Because `on-failure:5` would restart a misconfigured process five times, the message is the last log line of each attempt and the container ends in `exited`, visible in `docker compose ps`.

**Time budget (proposed):** cold start including image build under 5 minutes on a typical laptop; warm start under 30 seconds.

## 6. Configuration and secrets

### 6.1 Inventory

Defaults live in the Compose file via `${VAR:-default}`; `.env` is optional and git-ignored; `.env.example` documents every variable. Secrets never have defaults.

| Name | Purpose | Default | Required | Secret | Provider | Rotation |
| --- | --- | --- | --- | --- | --- | --- |
| `WEB_PORT`, `WEB_BIND` | Published port and bind address | `3000`, `127.0.0.1` | no | no | user | change and `up -d web` |
| `DB_NAME`, `DB_TUNING` | Database name; `small` or `bench` tuning | `mss`, `small` | no | no | user | recreate volume for name |
| `ENRICHMENT_MODE` | `auto` (real per provider if its key is set, else mock), `mock`, `real` (fail if a key is missing) | `auto` | no | no | user | restart worker |
| `ENRICHMENT_ENABLED` | Initial value of the kill switch | `true` | no | no | user | runtime flag afterwards |
| `SEED_SAMPLE` | Load the sample on start | `true` | no | no | user | none |
| `JEV_API_KEY` | jev (TypeSafe) key | none | only if mode is real for sentiment | **yes (external)** | user | replace in `.env`, `up -d worker` |
| `JEV_MODEL`, `JEV_BASE_URL` | Model id and endpoint | `jev-latest`, `https://api.typesafe.ai/v1/systemone` (from the jev docs) | no | no | user | restart worker |
| `OPENAI_API_KEY` | OpenAI key | none | only if mode is real for summary/topics | **yes (external)** | user | as above |
| `OPENAI_MODEL` | Exact model id | **none** (pending from the user) | yes when the key is set | no | user | restart worker |
| `*_PRICE_IN_PER_MTOK`, `*_PRICE_OUT_PER_MTOK` (per provider) | Prices for cost and budget (currency units per million tokens) | **none** | yes in real mode | no | user, from provider price pages | restart worker |
| `BUDGET_CURRENCY`, `BUDGET_JEV_DAILY`, `BUDGET_OPENAI_DAILY` | Daily cap per provider | `USD`, small placeholders (decision DS2) | no | no | user | restart worker; day row updated |
| `INPUT_TOKEN_CAP`, `WORKER_CONCURRENCY_*`, `RPM_*`, `MAX_ATTEMPTS`, `CALL_TIMEOUT_MS`, `PROMPT_VERSION` | Guardrails | per data-sanity section 9 | no | no | user | restart worker |
| `LOG_LEVEL` | Log level | `info` | no | no | user | restart |
| Postgres superuser password | Bootstrap and migrator only | generated | yes | **yes (internal)** | `secrets-init` | see 6.4 |
| `app_ingest`, `app_worker`, `app_read` passwords | Role credentials | generated | yes | **yes (internal)** | `secrets-init` | see 6.4 |
| `CURSOR_SECRET` | Keyed hash for cursor integrity and filter binding | generated | yes | **yes (internal)** | `secrets-init` | rotating invalidates open cursors only |

Provider prices are required in real mode because the cost guardrail is meaningless without them; if they are missing the worker refuses to start that provider in real mode with the message above. jev's pricing is not published in its docs (telemetry/ADR-0003 unknown), so this is a user input.

### 6.2 Mechanisms

- **Internal secrets** are generated by `secrets-init` into a named volume, one subdirectory per consumer, mounted read-only through volume `subpath` so each container sees only its own files. Services read them from files (`*_FILE` variables); no secret appears in `environment:`, `docker inspect`, image layers or command lines. The application builds connection settings from `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` and the password file, never a URL that embeds the password.

| Consumer | Files |
| --- | --- |
| db | `postgres_password` |
| migrate | `postgres_password`, `app_ingest_password`, `app_worker_password`, `app_read_password` |
| seed | `app_ingest_password` |
| web | `app_read_password`, `cursor_secret` |
| worker | `app_worker_password` |

- **External keys** (jev, OpenAI) are supplied by the user in `.env` (git-ignored) or the environment and passed only to the `worker` service. This is acceptable for the assignment; the limitation (visible in `docker inspect` on the host) is stated in the README. The code also reads `JEV_API_KEY_FILE` and `OPENAI_API_KEY_FILE` so a stronger setup (Compose `secrets:` from files, a secrets manager, SOPS) is a configuration change, not a code change.
- **Missing keys** (decision DV1): with `ENRICHMENT_MODE=auto` each provider independently falls back to the mock adapter, the worker logs one clear line per provider ("jev: mock (JEV_API_KEY not set)"), `mss_provider_calls_total{provider="mock"}` counts, every stored value has origin `mock`, the UI shows "Mock output", and the status page shows the mode. With `real`, a missing key stops the worker with a clear message.

### 6.3 Rules

No secrets in the repository, build context (`.dockerignore` excludes `.env*`, `secrets/`, `backups/`, `.git`, `.specs`, `node_modules`), build args, image layers, Compose file, client bundle (`NEXT_PUBLIC_*` is never used for anything sensitive; a build check greps `.next/static` for the key names and values), logs or error messages (redaction per telemetry section 5). `gitleaks` runs in CI and as a documented pre-commit hook. Provider keys are never given to `web`, `migrate`, `seed` or `db`.

### 6.4 Rotation

| Secret | Procedure | Restarts |
| --- | --- | --- |
| Provider key | Edit `.env`; `docker compose up -d worker` | worker |
| Role passwords | `docker compose run --rm migrate node dist/cli/rotate-secrets.js` (regenerates master values, runs `set_role_password`, rewrites consumer files) then `docker compose up -d web worker` | web, worker, next `seed` run |
| Superuser password | Same command; it also issues `ALTER ROLE` for the bootstrap user via the unix socket inside the `db` container | db is not restarted; migrate uses the new file |
| `CURSOR_SECRET` | Same command | web (open cursors become invalid, users re-search) |

Rotation is tested (section 9, T11). **Never delete only the `secrets` volume while keeping `pgdata`**: the generated superuser password would no longer match the database. `migrate` detects an authentication failure for the superuser and prints "Secrets volume and database volume are out of sync. Restore the secrets volume, or reset everything with `docker compose down -v` (this deletes all data)." (FP-V3).

## 7. Deployment, upgrade, rollback and recovery

- **Delivery:** build on the target (`docker compose up --build`); there is no registry in the assignment. Image tag `media-signal-app:local` plus a build label carrying the commit; base images are pinned by exact version (digest pinning is documented as a hardening step).
- **Upgrade (N to N+1):** `git pull`, optional backup (`docker compose --profile backup run --rm backup`), `docker compose up -d --build`. `migrate` runs first (one-shot) and applies expand-only migrations, so the running N version keeps working while `web` and `worker` are replaced. Contract steps (dropping a column) ship one release later. `worker` receives SIGTERM, stops claiming, finishes or releases in-flight jobs within the 40 s grace period; any job still `running` is returned by the sweeper after the visibility timeout. After the upgrade the reconciliation queries must still balance (no article lost, P2/P3).
- **Rollback:** images and configuration roll back with `git checkout <previous>` and `docker compose up -d --build`. Applied migrations do not roll back; each migration file carries the reverse SQL in a comment, and the safe rollback for data is restoring the pre-upgrade dump. Keep the previous image tag locally (`docker image ls`) until the new version is verified.
- **Backup and restore:** `docker compose --profile backup run --rm backup` writes `backups/mss-YYYYMMDD-HHMM.dump` (`pg_dump -Fc`, run as the superuser through the internal network). Documented off-host copy is the user's responsibility. Restore procedure: create a scratch database, `pg_restore`, run the reconciliation queries (DBA section 10), then swap if wanted. Point-in-time recovery and scheduled backups are documented, not built. Recovery targets (proposed, `UNCONFIRMED`): a nightly dump, so up to one day of data loss and a restore measured in minutes at this size; relevant only if the stack is kept running.

## 8. Host and platform settings

- **Docker Desktop on Windows:** use the WSL2 backend; the VM's memory is capped by `%UserProfile%\.wslconfig` (suggest `memory=4GB` for the stack with observability); disk grows with `pgdata` inside the VM.
- **Named volumes only for Postgres data.** Do not bind-mount the data directory from a Windows folder: slow, wrong file permissions, and fsync semantics differ.
- **Line endings:** `.gitattributes` with `* text=auto eol=lf` and explicit `*.sh text eol=lf`, `Dockerfile text eol=lf`, `*.sql text eol=lf`. A shell script checked out with CRLF fails inside the Alpine container with `exec` or `\r` errors, and silently changes SQL migration checksums between machines.
- **Clock:** the VM clock can drift after the host sleeps. Freshness figures compare `published_at` with database time; the status page shows database `now()` and the worker logs a warning if its clock differs from the database's by more than 5 seconds. `wsl --shutdown` restores sync.
- **Log rotation:** `json-file`, 10 MB x 3 per service (set in the Compose file).
- **Ports:** configurable (`WEB_PORT`); a conflict makes `up` fail with Docker's "port is already allocated"; the README names the variable to change.
- **Linux:** the same Compose files work; `shm_size`, `vm.overcommit_memory` and similar are not required at this size; for the growth path, NVMe storage and a Linux host are required for meaningful measurements (DBA E5).

## 9. Deployment test plan

| ID | Test | What it proves | How | Pass criteria |
| --- | --- | --- | --- | --- |
| T1 | Clean-clone bring-up | Zero-touch claim | Fresh clone, no `.env`, empty Docker cache for the project's volumes; `docker compose up -d --build --wait` (verify `--wait` tolerates exited one-shots, `UNCONFIRMED`; if not, poll `ps`) | Within 5 minutes: db healthy, web ready, worker healthy; migrate and seed exited 0 |
| T2 | Smoke | End-to-end wiring | `scripts/smoke.sh`: `/api/readyz`, search for each of the three golden queries, an Arabic and a Chinese term, `/api/aggregate`, `/api/status` | Golden ids match (search spec section 12); ledger `received 20 = admitted 20`; jobs reach `succeeded` in mock mode within 60 s |
| T3 | Mock mode (no keys) | Degraded mode is honest | T1 with no keys | Worker logs "mock" for both providers; UI shows "Mock output"; no error |
| T4 | Real mode (keys) | Real adapters | `.env` with both keys, model id and prices; `up -d worker` | Enrichments with origin `provider`, tokens and cost recorded, budget decreases; no key in logs |
| T5 | Mixed mode | Per-provider fallback | Only `JEV_API_KEY` set | Sentiment origin provider, summary/topics origin mock |
| T6 | Missing config | Fast failure | Key set, `OPENAI_MODEL` unset; prices unset in real mode | Worker exits with the specified message; web stays healthy |
| T7 | Idempotency | Safe repeats | `up` twice; `down` then `up`; reboot Docker Desktop | Same healthy state; `articles` count 20; no duplicate jobs |
| T8 | Reset | Volumes | `down -v` then `up` | Fresh secrets and data; works |
| T9 | Crash recovery | Resilience | `docker kill` worker mid-job; later `restart`; stop db during seed | Sweeper returns the job within the visibility timeout; seed fails cleanly and re-run completes; ledger balances |
| T10 | Port conflict | Clear failure | Occupy 3000 | Docker error plus README guidance; changing `WEB_PORT` works |
| T11 | Secret rotation | Procedure works | Run `rotate-secrets`, restart web and worker | App works with new credentials; old password rejected |
| T12 | Secrets and exposure | No leaks | `docker history`, `docker inspect`, `docker compose config`, env dump per service; gitleaks on the repo; grep `.next/static`; port scan of localhost | No secret in layers or inspect output of web/db; provider keys only in worker; only the web port is reachable |
| T13 | Least privilege | Roles | `psql` as `app_read` attempts INSERT and reading quarantine; as `app_worker` attempts DDL | All denied |
| T14 | Config validation | Bad values rejected | Invalid `WEB_PORT`, negative budget, unknown mode | Clear message at startup |
| T15 | Upgrade | Expand-only | Start N with data, apply N+1 | Migrations apply, data intact, reconciliation balances |
| T16 | Backup and restore | Recoverable | `backup`, restore to scratch DB | Counts and content hashes equal; reconciliation passes |
| T17 | Build hygiene | Image quality | Run as `node` user; read-only root filesystem works; image has no dev dependencies | `docker run --rm image id` shows non-root; app runs with `read_only: true` |
| T18 | Build does not touch the database | Reproducible builds | `docker build` with no network to `db` | Succeeds (all pages are dynamic; no DB access at build) |
| T19 | Windows line endings | Platform trap | Check out with `core.autocrlf=true`; build | Scripts still run (enforced by `.gitattributes`) |
| T20 | Capacity check | Section 3 | Run the DBA E5 and load profile from the testing spec on the target | Reported numbers recorded in the README; not a pass/fail gate at this scale |

**CI sketch (optional, `.github/workflows/ci.yml`):** lint, typecheck, unit tests; `docker compose config -q`; build; `docker compose up -d --wait` in mock mode; `scripts/smoke.sh`; gitleaks; optional image scan; `docker compose down -v`.

## 10. Repository artefacts to create

`compose.yaml`; `compose.dev.yaml` (database port on loopback); `Dockerfile` (multi-stage: `deps`, `build` with `next build` in standalone mode and a bundle of the worker and CLI entry points, `runner` on `node:22-bookworm-slim` pinned to an exact version, `USER node`, `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, only `.next/standalone`, `.next/static`, `public`, `dist`, `db/migrations`, no dev dependencies, no `.env`); `.dockerignore`; `.gitignore`; `.gitattributes`; `.env.example` (every variable with a comment, placeholders only); `ops/init-secrets.sh`; `db/postgres/small.conf` and `bench.conf` (from the DBA settings; both set `listen_addresses = '*'`); `db/migrations/*.sql`; `src/cli/{migrate,load,replay,flag,backfill-search-text,rotate-secrets,enqueue}.ts`; `src/config.ts` (single validated configuration); `data/sample_articles.json` (copy of the reference file); `ops/prometheus.yml`, `ops/alerts.yml`, `ops/grafana/provisioning/**` (optional profile); `scripts/smoke.sh`; `docs/runbook.md`; README sections "Run it", "Configuration", "Operations", "Upgrade and recovery"; CI workflow.

**Common commands** (all documented in the README; shown for bash and PowerShell, which differ only in path variables):

```bash
docker compose up --build                                   # start everything, foreground
docker compose up -d --build --wait                         # start detached and wait for health
docker compose run --rm seed                                # reload sample (idempotent)
docker compose run --rm seed node dist/cli/replay.js --id 7 # replay one quarantined item
docker compose run --rm migrate node dist/cli/backfill-search-text.js   # rebuild search_text after a normaliser change
docker compose run --rm migrate node dist/cli/flag.js enrichment_enabled false   # kill switch
docker compose --profile test run --rm test                 # integration tests
docker compose --profile bench run --rm bench               # disposable-database benchmark
docker compose --profile backup run --rm backup             # dump to ./backups
docker compose logs -f worker                               # follow worker logs
docker compose down -v                                      # reset everything, deletes data and generated secrets
```

## 11. Risks and hot paths

| ID | Failure point | Effect | Principle | Detection |
| --- | --- | --- | --- | --- |
| FP-V1 | Single host is a single point of failure | Outage until restart | P2 | Documented; restart policies; recovery test T9 |
| FP-V2 | Database healthcheck passes during initialisation (socket vs TCP) | Migrate runs against a half-initialised server | P2 | TCP healthcheck; T1/T7 |
| FP-V3 | Secrets volume deleted but `pgdata` kept | Superuser password mismatch; no one can connect | P2 | Clear migrate message; README warning; T8 |
| FP-V4 | `.env` or a key committed | Credential leak | P2 | `.gitignore`, `.dockerignore`, gitleaks, T12 |
| FP-V5 | Provider key reaches the client bundle or non-worker containers | Key exposure | P2 | Only the worker gets keys; bundle grep; T12 |
| FP-V6 | Restart loop on a configuration error | Noise, hidden cause | P2 | `on-failure:5`, last log line is the message, status shows `exited` |
| FP-V7 | Init scripts run only on an empty data directory | Roles missing after upgrades | P2 | Everything in the idempotent migrator, not initdb scripts |
| FP-V8 | CRLF line endings in scripts or SQL on Windows | Script failure, checksum mismatch | P2 | `.gitattributes`; T19 |
| FP-V9 | `next build` reaches the database at build time | Build fails offline | P2 | All routes dynamic; T18 |
| FP-V10 | Standalone output missing `.next/static` or `public` | Unstyled UI | P2 | Copy steps in Dockerfile; smoke test fetches a static asset |
| FP-V11 | OOM kill of `db` at its memory limit | Crash recovery loop | P2 | `shared_buffers` kept to a quarter of the limit; `docker inspect` OOMKilled check in T9 |
| FP-V12 | Observability profile starves the database | Slow search | P1 | Separate limits; profile off by default |
| FP-V13 | Image tag drift (`postgres:16` moves) | Different behaviour between machines | P2 | Pin exact version and digest at build; renew deliberately |
| FP-V14 | Clock drift in the Docker VM | Wrong freshness numbers | P1 | Clock check warning; status page shows DB time |
| FP-V15 | Disk fills from data or logs | Database stops | P2 | Log rotation; documented size model; status shows database size |
| FP-V16 | `service_completed_successfully` one-shots confuse `up --wait` | `up --wait` reports failure | P2 | T1 verifies; fallback polling script |
| FP-V17 | Subpath volume mounts unsupported on an older engine | Stack does not start | P2 | Requirement stated; fallback: one secrets volume per consumer |

| ID | Path | Why hot | What needs a human | Measurement |
| --- | --- | --- | --- | --- |
| HP-V1 | Cold build and start | First impression for graders | Review Dockerfile layers and caching | Time in T1 |
| HP-V2 | Migrate on every start | Runs each boot | Confirm it is a no-op and takes under 2 s when up to date | Log timing |
| HP-V3 | Database memory limit versus settings | OOM risk | Review tuning file against limit | T9 and `docker stats` |

## 12. Handoff

- **carma-backend-testing:** shared Compose-based test environment: profile `test` runs against the same `db` using a disposable database name; `ENRICHMENT_MODE=mock` for deterministic runs; `down -v` between suites; `scripts/smoke.sh` is the deployment smoke test; T9 to T20 map to the testing spec's fault and recovery cases.
- **carma-plan:** the artefact list in section 10 is the task list; order: `.gitignore`/`.gitattributes` and `git init` first; Dockerfile and Compose skeleton with `db` and `migrate`; secrets-init; app and worker; seed; healthchecks; docs; optional profiles last.
- **carma-benchmark (later):** `docker compose --profile bench run --rm bench` creates and drops a disposable database on the same server using the migrator credentials.

## 13. Decisions needed and open questions

| ID | Decision | Options (recommended first) |
| --- | --- | --- |
| DV1 | Behaviour when a provider key is missing | (a) `auto`: that provider falls back to a clearly labelled mock, so a grader can run the stack with no keys. (b) Fail fast: the worker refuses to start without both keys; honest, but nothing works for anyone without keys |

Held defaults: build on the target; web published on `127.0.0.1` only; no TLS (the brief excludes it); observability off by default (T1); small database tuning by default; internal secrets generated, external keys from `.env`.

Open questions: host CPU, RAM and disk; whether graders' machines can pull images and reach the providers; the OpenAI model id and prices for both providers (required for real mode, not for mock); whether the README should include PowerShell variants of the commands (assumed yes).
