---
name: carma-devops
description: Deployment and testing plan for Carma features, built from the carma-architect output. Assumes everything runs under Docker Compose on the target machine (database, web app, workers, observability) and must come up fully wired from a single docker compose up with no manual steps. Covers service topology, startup ordering and healthchecks, keys and secrets handled as configuration, config layering, upgrades, rollback, backup and restore, host settings, capacity fit for ~800 articles/sec on one host, and a deployment test plan. Writes numbered specs to .specs/devops/. Use whenever a Carma feature needs to be deployed, containerised, run locally or on a server, or whenever the user mentions Docker, docker-compose, deployment, secrets, environment variables, config, CI/CD, infrastructure or "how do we run this", even if the skill is not named.
---
 
# carma-devops
 
The bar for this skill is simple to state and demanding to meet: on the target machine, someone runs `docker compose up` and a working, fully wired system appears. The database exists with its extensions, roles and partitions, migrations have run, the application and workers are connected, observability is collecting, and secrets are in place, all without hand-editing anything or running steps in a particular order from a README.
 
Read `references/carma-context.md` first for the principles, constraints and spec conventions.
 
Compose runs on one host. That is a real limit for a pipeline sized at 800 articles a second, so this skill checks the fit between the design and the machine honestly and says where a single host stops being enough, instead of assuming it will be.
 
## Inputs
 
Read the latest non-superseded specs for the same feature: `.specs/architect/` (components, data flow, FP and HP registers; ADRs in `.specs/architect/adrs/`), and where present `.specs/data/dba/` (extensions, config parameters, migrations, roles, capacity), `.specs/telemetry/` (collector, storage and dashboards needed), `.specs/data/sanitization/` (secrets and limits needed at runtime), `.specs/search/` (language configurations, dictionaries, extensions) and `.specs/ux/` (web app). Take from them every component that must run, every setting and secret it needs, and the throughput and capacity numbers. If the architect spec is missing, say so and ask.
 
Inspect the codebase for what exists: Dockerfiles, compose files, `.dockerignore`, CI configuration, environment and config files, startup and migration scripts, healthchecks, how config and secrets are read, and anything committed that looks like a secret. Record paths. Existing secrets in the repository are a finding to raise immediately.
 
## Workflow
 
### 1. Target machine and capacity fit
 
Establish what it runs on: operating system and architecture, CPU, memory, disk type and size, network (can it pull images, or is it offline), Docker Engine and Compose versions, and who administers it. Ask for what you cannot find. Prefer Linux for anything performance-related; Docker on a desktop OS adds a virtual machine whose I/O will mislead any benchmark.
 
Then test the design against the machine using the architect and DBA numbers: CPU and memory budget at 800 articles a second, database write rate, WAL and disk growth per day, the observability stack's own footprint. State clearly where one host is enough, where it is marginal, and what would break first (usually disk I/O or memory for the database). Name the point at which Compose is no longer the right tool, so the user knows it, without turning this into a platform migration plan.
 
### 2. Service topology
 
Define every service, and for each its purpose, image, ports, volumes, dependencies, resource limits and healthcheck. Typical set, to adapt to the design:
 
- **Database.** An image pinned by version (never `latest`), built with exactly the extensions the DBA plan needs. In Compose the image is under our control, so "is this extension permitted" is partly our choice, but record whether Carma's real environment will match, because behaviour that works here may not carry over. Tuning parameters from the DBA spec, set through configuration. Enough shared memory (`shm_size`), because the container default is small and breaks parallel queries. A named volume on fast storage for data.
- **Connection pooler** if the DBA plan includes one.
- **One-shot jobs.** Migrations, database bootstrap (roles with least privilege, extensions, initial partitions, reference data), and secret generation. These run to completion and the services that depend on them wait for that.
- **Application services.** Web app, API, ingestion workers, enrichment workers, scheduler. Workers must scale by replica count and shut down gracefully so claimed items go back to the queue (P2).
- **Edge.** A reverse proxy handling TLS if anything is exposed. Only the proxy publishes ports. The database is not published to the host by default.
- **Observability.** The collector, metric and log storage, and dashboards the telemetry spec calls for, sized so they do not starve the database.
- **Backup job** per the DBA recovery plan.
- **Optional profiles.** Compose profiles for the load generator, a disposable database for quick benchmarks (carma-benchmark runs Node.js benchmarks against it and resets it afterwards), development tools and anything not needed in normal running.
Isolate networks (an internal network for the data path, a separate edge network), run containers as non-root where the image allows, drop capabilities, use read-only filesystems where possible, and set CPU and memory limits from measured numbers rather than guesses. Pin every image, and plan how updates are chosen deliberately.
 
### 3. Zero-touch bring-up
 
This is the core requirement. Design the start sequence so it works the first time on an empty machine, again on a second run, and after a reboot.
 
- **Ordering by readiness, not by start.** Use healthchecks and `depends_on` with conditions (`service_healthy`, `service_completed_successfully`) so the migration job waits for a database that accepts connections and the application waits for migrations. A healthcheck must prove readiness (the database accepts a query, the worker can claim work), not that a process exists.
- **Idempotent initialisation.** Database init scripts in the standard image directory run only on an empty data directory, so anything that must apply on every start or upgrade belongs in the migration job, written to be safe to run repeatedly. Test an empty start and a restart over existing data.
- **Everything wired.** Service discovery by Compose service name, connection strings built from configuration, extensions created, roles and grants applied, partitions pre-created, reference data loaded, dashboards provisioned from files. No step is left for a human.
- **Boot survival.** Restart policies on long-running services, and the Compose project itself started at machine boot (for example a systemd unit), so a reboot recovers unattended.
- **Fast, clear failure.** If something required is missing or invalid (a secret, a setting), the stack stops with a message that says what and how to fix it, not a stack trace three services away.
### 4. Keys, secrets and configuration
 
Secrets are configuration with extra rules. Specify both together.
 
- **Inventory.** A table of every setting: name, purpose, default, required or optional, secret or not, who provides it, how it is rotated. Include database role passwords, application signing keys, LLM or scorer API keys, TLS material, and any credentials for backup storage.
- **Two kinds of secret, two mechanisms.**
  - *Internal secrets* (database role passwords, session and signing keys) can be generated. For true zero-touch, a one-shot service generates them on first run into a protected named volume that services mount read-only and read through `_FILE` style variables. (Compose's native `secrets:` with a file source expects the file to exist before `up`, so it suits provided secrets, not generated ones. Check what the installed Compose version supports, such as environment-sourced secrets.)
  - *External secrets* (an LLM provider key) cannot be generated. The user supplies them through a git-ignored file or the environment, and the stack validates their presence at start. If a required one is missing, fail with a clear message, or run in a deliberate degraded mode (for example without LLM enrichment, with confidence shown as "no confidence available", P6) if the user chooses that. Put the choice to them.
- **Rules.** No secrets in images, build arguments, the Compose file, the repository, logs or error messages; `.env` and secret files git-ignored; a committed `.env.example` with placeholders and comments; each database role has its own credential (least privilege, from the data-sanity spec); secrets reach containers as files, not command-line arguments; logs and traces redact them; the LLM key is subject to the spend limits in the data-sanity spec.
- **Rotation.** State how each secret is rotated and what restarts when it changes, and test that procedure.
- **Config layering.** Defaults in the repository, per-environment overrides through Compose override files or variables, one place per setting, validated at startup. Include the database tuning parameters from the DBA spec as versioned configuration, not edits inside a container.
- **Stronger options.** If the threat model needs more than files on a host (a secrets manager, SOPS-encrypted files, Docker Swarm secrets), list them as options with their cost, and keep the file-based design as the baseline.
### 5. Deployment, upgrade and recovery
 
- **Delivery.** Build images in CI and pull from a registry, or build on the target? Decide, considering whether the target has internet access. Tag releases immutably.
- **Upgrade.** The procedure to move from version N to N+1 (pull, run migrations, restart), what the data-sanity and DBA specs require for compatibility (expand then contract migrations, so the old version keeps working during the change), how workers drain, and what ingestion does during the restart: the ledger must show no articles lost (P2, P3), and anything late is flagged as late.
- **Rollback.** What can be rolled back (images, config) and what cannot (applied migrations), with the plan for each. Keep the previous images available.
- **Backup and restore.** From the DBA recovery plan: scheduled backups and WAL archiving as a Compose service, copies kept off the host, and a restore procedure that is rehearsed, not assumed.
- **Host settings that decide whether it works.** Log rotation for container logs (unbounded logs fill disks), Docker daemon settings, disk space alerts for the data volume and WAL, kernel and file-descriptor limits the database needs, and time synchronisation. The freshness target is measured from `published_at` against the machine's clock, so clock drift directly corrupts the 15-minute measurement.
### 6. Deployment test plan
 
A bring-up that works once on a developer's laptop proves little. Specify tests that prove the claims. The pipeline data-correctness and load tests belong to carma-backend-testing; this plan covers the deployment and the platform, and the two share the same Compose-based test environment.
 
- **Clean-machine bring-up.** On a fresh machine with no cached images, one command produces a healthy system within a stated time budget. This is the acceptance test for the whole skill.
- **Smoke test.** After `up`, every healthcheck is green, a few sample articles in English, Arabic and Chinese go through ingestion, appear in search, and show in telemetry, and the reconciliation count balances (the walking skeleton running as a deployment check).
- **Idempotency.** `up` twice, `down` then `up`, and reboot the machine: same healthy state, no duplicated data, no lost data.
- **Fault tests.** Kill and restart each service, stop the database mid-ingestion, fill a disk (or simulate it), hit a memory limit, and verify recovery and that the failure is visible in telemetry and in the reconciliation counts.
- **Upgrade and rollback.** Upgrade from the previous version with real data in place, and roll back what can be rolled back.
- **Backup and restore.** Restore into a clean environment and verify counts and content hashes against the source.
- **Secrets and exposure.** Missing or malformed secrets give clear failures; no secrets in image layers, environment dumps, `docker inspect`, logs or the repository (use secret scanning and image scanning); only intended ports are reachable from outside; the database is not exposed.
- **Config validation.** Bad values are rejected at startup with a useful message.
- **Capacity check.** Run the load profile from the testing spec on the target hardware and compare the results with the capacity fit from step 1.
- **CI.** Validate the Compose files, scan images and secrets, bring the stack up in CI, and run the smoke and integration tests against it on every change.
### 7. Failure points and hot paths
 
Extend the architect registers with `FP-V` and `HP-V` entries in the same format. Typical candidates: the single host as a single point of failure, disk full from data, WAL or logs, out-of-memory kills, a startup race when a healthcheck lies, init scripts that only run once, secret rotation breaking connections, image tag drift between environments, clock drift, port conflicts, and the observability stack competing with the database for resources.
 
### 8. Decisions to put to the user
 
Raise choices that need a human: the target hardware and whether one host is acceptable as the long-term target, building on the target or pulling from a registry, auto-generated versus provided secrets and what happens when an external key is missing, whether the observability stack is on by default or a profile, TLS and domain, backup destination and recovery targets. Use the protocol in the context file.
 
## Output
 
Write the spec with these sections:
 
1. **Summary** (what comes up from one command, and whether one host is enough)
2. **Inputs and current state** (existing Docker and CI files with paths, secrets findings)
3. **Target machine and capacity fit**
4. **Service topology** (table: service, purpose, image, ports, volumes, depends on, healthcheck, resource limits; network diagram; an illustrative Compose sketch labelled as such)
5. **Zero-touch bring-up sequence** (ordered steps with the readiness gate for each)
6. **Configuration and secrets** (inventory table, generation and supply mechanisms, rules, rotation)
7. **Deployment, upgrade, rollback and recovery**
8. **Host and platform settings**
9. **Deployment test plan** (table: test, what it proves, how, pass criteria)
10. **Repository artefacts to create** (Compose files, Dockerfiles, `.env.example`, bootstrap and migration jobs, CI configuration, documentation)
11. **Risks and hot paths** (`FP-V` and `HP-V`)
12. **Handoff** (to carma-backend-testing for the shared test environment, and to carma-plan for tasks)
13. **Decisions needed and open questions**
## Persisting the work (when run inside a codebase)
 
Follow "Spec conventions" in the context file. Number with `python scripts/next_spec_number.py .specs/devops`, write `.specs/devops/NNNN-<feature-slug>.md` with `spec: carma-devops` front matter and list the architect spec (and any DBA, telemetry and data-sanity specs used) under `inputs`. Edit in place while `draft`. When the user decides a question that should be binding (for example the secrets approach), suggest recording it as an ADR through carma-architect.
 
If you are not in a codebase, deliver the output in the conversation and offer to save it.