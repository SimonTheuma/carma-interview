# Media Signal Service

Searchable news corpus with boolean queries, async enrichment (sentiment / summary / topics), and honest UI states. Built as the Senior Fullstack home assignment for Carma (track F per ADR-0018).

## How to run

```bash
docker compose up -d --build --wait
```

Open http://127.0.0.1:3000. No `.env` is required: internal secrets are generated into a Docker volume; enrichment runs in **labelled mock mode** when provider keys are absent.

Optional provider keys (worker only) — put them in a local `.env` (never commit):

```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
OPENAI_PRICE_IN_PER_MTOK=0.15
OPENAI_PRICE_OUT_PER_MTOK=0.6
JEV_API_KEY=...
JEV_PRICE_IN_PER_MTOK=...
JEV_PRICE_OUT_PER_MTOK=...
```

Observability profile (optional):

```bash
docker compose --profile observability up -d
```

Prometheus: http://127.0.0.1:9090 · Grafana: http://127.0.0.1:3001 (user `admin`; password from the generated `grafana_admin_password` secret in the Compose secrets volume).

Production note: pin container image digests (`image@sha256:…`) before any non-local deploy.

## Uploading articles

Operators can load a JSON array of articles via **Upload** in the nav (`/upload`) or `POST /api/uploads`.

PoC note: no upload token is required. Upload when Compose is up:

```bash
curl -sS -F file=@.specs/references/sample_articles.json \
  http://127.0.0.1:3000/api/uploads
```

Poll progress: `GET /api/uploads/<batchId>` or open `/upload?batch=<batchId>`.

Limits (overridable in `.env`): 5 MiB body, 1000 articles, UTF-8 only, one upload in flight, 10 uploads per hour. Kill switch: `UPLOAD_ENABLED=false` (returns 503 `upload_disabled`; the rest of the app stays up).

Identical re-uploads are duplicates (no new jobs). Changed content for the same `(source, id)` becomes a new **article version** (ADR-0021); search still shows one row per article. Rollback of migration `0003` after live versioning can lose versions beyond 1 from `articles` unless restored from `article_versions` — prefer image/config rollback only.

Related: [ADR-0019](.specs/architect/adrs/0019-upload-route-uses-ingest-pool-synchronous.md), [ADR-0021](.specs/architect/adrs/0021-changed-resubmission-stored-as-new-version.md), [ADR-0037](.specs/architect/adrs/0037-upload-open-when-enabled.md).

## Article translation

Non-English articles get a third enrichment part (`translation`) at ingest. Without `OPENAI_API_KEY` the worker uses a labelled **mock translator** (`[mock translation]` prefix). The article page shows English by default with **Show original**; search matches original and translated text.

- Kill switch: `UPDATE system_flags SET value='false' WHERE key='translation_enabled'`
- Budget: `BUDGET_TRANSLATE_DAILY` (default 3) is additive to `BUDGET_OPENAI_DAILY` (ADR-0029)
- Deploy **web and worker together** after migration `0004` (`ingest_new_version` signature change)
- Readiness: `/api/readyz` (checks `article_translations`); liveness `/api/healthz`
- No backfill of older foreign articles (ADR-0028)

Related: [plan 0003](.specs/plan/0003-article-translation.md), ADR-0022–0029.

## How to test

```bash
npm test
npm run typecheck
# with stack up:
sh scripts/smoke.sh
```

## Plan

Before coding, the work was phased in [`.specs/plan/0001-media-signal-service.md`](.specs/plan/0001-media-signal-service.md) (foundations → ingest/search/enrichment → UI) then [`.specs/plan/0002-json-file-upload.md`](.specs/plan/0002-json-file-upload.md) (upload + versioning). Translation followed as plan 0003.

Under a hard time cut, drop in this order: article translation (plan 0003), observability profile (Prometheus/Grafana), Upload UI polish (keep `POST /api/uploads`), then trends split dimensions beyond one filter. Core search, enrichment with mock fallback, and the search page stay.

## Architecture & Decisions

- **Stack:** Next.js 16 (App Router) + TypeScript + PostgreSQL 16 + Docker Compose (ADR-0002). One app image serves web, worker, migrate, and seed.
- **Search:** Hand-written scanner + recursive-descent parser instead of `websearch_to_tsquery`: we need case-sensitive `AND`/`OR`/`AND NOT`, nested brackets, phrase quotes, and suffix `*` with English stem only when starred (ADR-0005, ADR-0036). Trade-off: more code and a depth/term cap, clearer operator semantics than Postgres’s websearch dialect. **Decision (ADR-0036):** bare Latin terms are exact whole-word matches on `simple` FTS — `startups` does not match `startup`; use `startup*` / `startups*` for prefix + English stem. Same rules on Search and Trends. Arabic/CJK and other non-Latin scripts use substring whether bare, quoted, or starred (ADR-0007, ADR-0038). `AND NOT` excludes by original text only — not translations or summaries (ADR-0027, ADR-0040). Summaries are searchable. Recency keyset pagination only (ADR-0016).
- **Indexes:** Keyset indexes put the filter column first (`published_at`, `source`, `language`) so date/source/lang filters stay index-friendly (`db/migrations/0001_init.sql`). GIN on `search_vector` / optional trigram on `search_text` for FTS and non-Latin leaves. English stem expression indexes and summary FTS in `0007_english_search_indexes.sql` (ADR-0030, ADR-0034, ADR-0035).
- **Enrichment:** jev for sentiment, OpenAI `gpt-4o-mini` structured output for summary/topics when keys present; otherwise realistic mock with origin `mock` (ADR-0003, ADR-0013). Daily budget deferral, never drop (ADR-0010). Circuit breaker per provider.
- **Schema:** Append-mostly articles; jobs / enrichments / derived_values ledgers; roles `app_ingest`, `app_worker`, `app_read`. See `db/migrations/0001_init.sql`.
- **UI:** Wireframe palette and states from `.specs/ux/`; custom SVG trends chart + table (ADR-0015).
- **Upload:** Open when `UPLOAD_ENABLED` (ADR-0037); size/rate/budget guardrails, no shared token.

### Golden queries (sample of 20)

| ID | Query | Expected external ids |
| --- | --- | --- |
| G1 | `"oil prices" AND (geopolitical OR "supply chain")` | 1 |
| G2 | `renewable AND NOT (nuclear OR coal)` | 5 |
| G3 | `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` | none (correct; startup\* excludes id 10) |
| G3a | `AI AND ("healthcare" OR "diagnostic")` | 10 |

## LLM Cost Analysis

With keys unset, cost is **$0** (mock). Numbers below use **published OpenAI list prices** (read 2026-10-28) and token estimates from the 20-article sample via the prompt builder — not a live billed run. Detail: [`reports/measurements.md`](reports/measurements.md).

| Provider / model | Tokens in (avg) | Tokens out (est.) | $/article | 50k/day (0% cache) | 50k/day (30% cache) |
| --- | --- | --- | --- | --- | --- |
| OpenAI **gpt-4o-mini** | ~338 | ~100 | **$0.000111** | **$5.53** | **$3.87** |
| OpenAI gpt-5-nano (alt.) | ~338 | ~100 | $0.000057 | $2.84 | $1.99 |
| OpenAI gpt-4.1-mini (alt.) | ~338 | ~100 | $0.000295 | $14.75 | $10.33 |
| jev (sentiment) | — | — | unknown list price | gated by `BUDGET_JEV_DAILY` ($5) | same |

**Model choice (gpt-4o-mini):** cost stays under the default `$10` OpenAI enrich daily cap at 50k articles even with little cache; quality is enough for 1–2 sentence summaries and a closed topic enum with strict JSON schema; latency is low without a reasoning step. `gpt-5-nano` is cheaper but newer/less exercised here; `gpt-4.1-mini` costs ~3× for little gain on this short structured task. jev is kept for calibrated-style class probabilities; its docs do not publish prices, so spend is capped by the budget ledger and required `JEV_PRICE_*` when real.

Cache key: `sha256(prompt_version + text)`. Guardrails: daily caps (`BUDGET_*_DAILY`), per-call reserve, concurrency/RPM, attempts cap, breaker, kill switch (`enrichment_enabled`).

## Security & Responsibility

| Risk | Control | Tests |
| --- | --- | --- |
| SQL injection | Bound parameters only; parser never concatenates user text into SQL | `tests/unit/parse.test.ts` |
| XSS | React text escaping; sanitiser strips markup; per-request nonce CSP for scripts (`src/proxy.ts`) with `style-src-attr 'unsafe-inline'` for a few style attributes | sanitiser unit tests; `tests/unit/csp-proxy.test.ts`; e2e `csp.spec.ts` |
| Prompt injection | Nonce-fenced prompts (headline + body); injection detector → `trust=low`; never drop | `inject-detect.ts`, `prompt.test.ts` |
| Cost abuse | Budget ledger, deferral, caps | worker budget path |
| Secrets | Generated volume secrets; provider keys only on worker; `.gitignore` / `.dockerignore` | devops D-T12 checklist |

## Reflection

Replace this section with your own notes before submission. Working notes: [`docs/reflection-notes.md`](docs/reflection-notes.md). Put the LLM transcript under `docs/transcript/` when ready.

## Growth path (documented, not built)

Partitioning + `article_keys`, restrict trigram index, queue extension, vectors/tiered enrichment, relevance ranking, human review controls, OpenTelemetry. 800 articles/s is not claimed.

## Not proven

- 800/s throughput on this host
- 15-minute freshness SLO on live feeds (sample is backfill only)
- Exact jev pricing / input limits until supplied
