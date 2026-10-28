# Media signal service plan
_Exported on 10/28/2026 at 21:54:27 GMT+1 from Cursor (3.20.17)_

---

**User**

we need to plan and implement @.specs/plan/0001-media-signal-service.md. @.specs/ux/wireframes/Media Signal Service.html should be used as the design reference for the front-end parts of the deliverables.

---

**Cursor**

I'll read the plan spec and wireframe, then map them against the current codebase so we can draft an accurate implementation plan.

The execution plan is already detailed; next I'll check the repo bootstrap and UX/wireframe details so the implementation plan fits what's already here.

I have enough to draft the implementation plan: track F is locked by ADR-0018, the Next.js scaffold already exists, and the wireframe plus UX spec define the UI.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

Starting Phase 1: reshaping the scaffold and building the Compose/Postgres foundations. I'll work through the plan tasks in order.

Building Phase 1 foundations: guardrails, shared libs, Docker/Compose, and schema.

Implementing Phase 2 core libraries: sanitiser, normaliser, query parser, and ingest.

Implementing enrichment providers and the worker loop.

Building the UI screens and remaining API routes.

Fixing TypeScript errors, then rebuilding.

Disabling `cacheComponents` so dynamic routes work with this Next.js version.

Docker Desktop isn't running. Starting it, then bringing the stack up.

Search works. Fixing `app_read` grants for readiness and status (schema_migrations + quarantine visibility).

Weekly aggregates match. Merging seed into migrate so `compose --wait` works with one-shots, then finishing docs and remaining todos.

Track F is implemented and verified against the running Compose stack.

### Verified on your machine
- `docker compose up` → migrate + seed, web, worker healthy
- **20 admitted**, enrichment **20/20 succeeded** (mock)
- Golden **G1 → id 1**, **G2 → id 5**
- Weekly aggregate **1, 3, 3, 6, 6, 1**
- `/api/readyz` 200, UI `/` 200
- Unit tests: **21 passed**; E1 trigrams work for CJK/Arabic (`trgm_index=on`)

### What’s in the repo
Compose/Postgres/roles, ingest + boolean search, enrichment worker (mock/real adapters), Search / Trends / Article / Status UI (wireframe palette), Prometheus/Grafana profile, README + `docs/environment.md` + measurement notes.

### Your remaining human items
1. **Reflection** in README (draft placeholder from `docs/reflection-notes.md`)
2. **Transcript** export under `docs/transcript/`
3. Optional **real providers**: keys/model/prices in `.env` only (never commit)

Bring-up: `docker compose up -d --build --wait` then open http://127.0.0.1:3000.

