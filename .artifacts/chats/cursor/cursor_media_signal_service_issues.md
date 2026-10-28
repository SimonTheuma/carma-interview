# Media signal service issues
_Exported on 10/28/2026 at 21:54:17 GMT+1 from Cursor (3.20.17)_

---

**User**

in @.specs/review/0001-media-signal-service.md we've highlighted a number of implementation issues. can we plan fixes for them?

---

**Cursor**

I'll read the review doc and trace the related implementation so we can plan concrete fixes.

Next I'll inspect the cited worker, ingest, and test code so the plan maps each finding to a concrete fix.

The review splits findings into blockers, should-fix, and consider. Scope changes the plan a lot — clarifying that first.

The review splits findings into **blockers**, **should-fix**, and **consider**. That changes the plan a lot.

Which scope should we plan for?

1. **Core** — Blockers + should-fix only: **F1–F8**, **S1** (Grafana password), lint (**F4**), and the §5 hot-path cleanups tied to those (quarantine helper, ROLE dead branch, cache reuse vs remove, claim-before-write). Tests: the review’s minimum set (**F-BRK-ATT**, lost-claim race, duplicate delivery, mid-batch quarantine, budget deferral). Skip benchmarks, smoke, and “consider” items.
2. **Core + consider** — Above, plus **S2–S4**, module-level pool reuse, `__MACOSX` ignore, and similar cleanup.

Also: for **F5** (dead cache lookup), the testing spec expects real reuse (`origin = cache`, cost 0). I’ll plan **implement reuse**, not delete the lookup, unless you want otherwise.

---

**User**

2 is good

---

**Cursor**

I'll draft the full plan for core + consider: checking the pool, secrets, log-redaction, and UI lint spots so each fix is concrete.

Creating the plan for core fixes plus the consider items.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

Starting with F1 (claim-first finish), then working through the rest of the plan.

Implementing claim-first finish helpers and cache reuse together, then updating the worker loop.

Fixing `finishFromCache` so we verify the cache source before claiming the job.

Updating the breaker, classify, validate-output, and config, then rewriting the loop.

Moving the provider call outside the finish transaction.

Rewriting ingest with quarantine helper, F3 continue-on-error, and text repair.

Fixing UI setState-in-effect issues, then tackling secrets and the shared pool.

Updating secrets, logging, and gitignore next.

Writing unit tests and a skippable integration harness.

Fixing the typecheck, test, and lint failures.

All review fixes from the plan are in. Summary:

**Blocker / worker**
- Finish path updates the job claim first; lost claims release budget and skip enrichment writes
- Cache reuse via `finishFromCache` (`origin=cache`, cost 0)
- Half-open breaker single-probe, concurrency wired, `CLAIM_VISIBILITY_SECONDS` validated against call timeout
- `InvalidOutputError` + safer `last_error` formatting

**Ingest / UI / ops**
- Quarantine helper, continue-on-item-error (P3), text repair for NULs/surrogates, no `ROLE` env mutation
- Lint/UI setState-in-effect cleaned up; shared `getWebPool`
- Grafana password from secrets; `chmod 600`; log redaction extended; `__MACOSX` ignored

**Tests**
- 43 tests passing (unit + skippable integration harness when Postgres is down)
- Covers F1 claim-first, F-BRK-ATT, breaker probe, classifier, ingest mid-batch, cache, budget deferral

`tsc --noEmit` clean, `vitest` 43/43, `eslint src tests --quiet` clean.

---

**User**

getting an issue when launching docker compose:
 
"✘ Container media-signal-migrate-1       service "migrate" didn't complete successfully: exit 1" 

can you investigate and propose a fix?

---

**Cursor**

I'll check the migrate container logs and related compose/migrate setup to find why it's exiting 1.

Permission denied on secret files — our S2 `chmod 600` change likely broke the non-root `node` user. Checking ownership and how the app image runs.

Root cause: S2 set secrets to `600` owned by root, but migrate/web/worker run as `node` (uid 1000). Fixing `init-secrets.sh` to chown each consumer's secrets to the matching container uid.

**Cause:** The S2 secrets hardening set files to `chmod 600` owned by **root**. The migrate (and web/worker) image runs as **`USER node` (uid 1000)**, so reading `/run/secrets/postgres_password` failed with `EACCES`.

**Fix:** Update [`ops/init-secrets.sh`](ops/init-secrets.sh) so each consumer tree is still `600`, but owned by the UID that reads it:

| Path | Owner |
| --- | --- |
| `db/` | `999` (postgres) |
| `migrate/`, `seed/`, `web/`, `worker/` | `1000` (node) |
| `grafana/` | `472` (grafana) |

I re-ran secrets-init and migrate; migrate completed with **exit 0**.

To bring the rest of the stack up:

```bash
docker compose up -d --wait
```

