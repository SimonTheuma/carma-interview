# Media Signal Service

Searchable news corpus with boolean queries, async enrichment (sentiment / summary / topics), and honest UI states. Built as the Senior Fullstack home assignment for Carma (track F per ADR-0018).

## How to run

```bash
docker compose up -d --build --wait
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). No `.env` is required: internal secrets are generated into a Docker volume; enrichment runs in **labelled mock mode** when provider keys are absent.

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

Prometheus: [http://127.0.0.1:9090](http://127.0.0.1:9090) · Grafana: [http://127.0.0.1:3001](http://127.0.0.1:3001) (user `admin`; password from the generated `grafana_admin_password` secret in the Compose secrets volume).

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

My process started by going through the site as well as what was discussed during the initial interview to identify the core design principles, then I built a set of skills (found in .artifacts/skills) that cover various aspects deemed important to Carma's operations, such as data sanity, searchability, db administration, etc. This process alone took about 1.5 - 2 hours, but it was worth the investment and gains later on. I also added a PR skill that I was running manually after the Cursor completes execution to highlight performance issues, feature completion, etc.  

The way I envisaged the workflow was that every key decision can be tracked in its respective folder in .specs, so that this also serves as a reference point for agents to find reasons behind past decisions, and to prompt the user when a specification is about to be broken or superseded.  It was also very tempting to overscope with the setup, and it happened a few times, but the skills actually reined me in to remain on track with what was on the specification document. We also used the ADR standard to document architectural decisions over and above the actual specification.

After creating the skills, it was a case of inputting the requirements file and running it through the workflow. As per the specification, did not really focus that much on the front-end, but I did manual testing myself as it was a simple project. In more complicated ones I would also have added a skill for front-end tests using Playwright. 

Before coding, the work was phased in `[.specs/plan/0001-media-signal-service.md](.specs/plan/0001-media-signal-service.md)` (foundations → ingest/search/enrichment → UI) then `[.specs/plan/0002-json-file-upload.md](.specs/plan/0002-json-file-upload.md)` (upload + versioning). Translation followed as plan 0003.

Under a hard time cut, drop in this order: article translation (plan 0003), observability profile (Prometheus/Grafana), Upload UI polish (keep `POST /api/uploads`), then trends split dimensions beyond one filter. Core search, enrichment with mock fallback, and the search page stay.

## Architecture & Decisions

- **Stack:** Next.js 16 (App Router) + TypeScript + PostgreSQL 16 + Docker Compose (ADR-0002). One app image serves web, worker, migrate, and seed.
- **Search:** Hand-written scanner + recursive-descent parser instead of `websearch_to_tsquery`: we need case-sensitive `AND`/`OR`/`AND NOT`, nested brackets, phrase quotes, and suffix `*` with English stem only when starred (ADR-0005, ADR-0036). Trade-off: more code and a depth/term cap, clearer operator semantics than Postgres’s websearch dialect. **Decision (ADR-0036):** bare Latin terms are exact whole-word matches on `simple` FTS — `startups` does not match `startup`; use `startup`* / `startups`* for prefix + English stem. Same rules on Search and Trends. Arabic/CJK and other non-Latin scripts use substring whether bare, quoted, or starred (ADR-0007, ADR-0038). `AND NOT` excludes by original text only — not translations or summaries (ADR-0027, ADR-0040). Summaries are searchable. Recency keyset pagination only (ADR-0016).
- **Indexes:** Keyset indexes put the filter column first (`published_at`, `source`, `language`) so date/source/lang filters stay index-friendly (`db/migrations/0001_init.sql`). GIN on `search_vector` / optional trigram on `search_text` for FTS and non-Latin leaves. English stem expression indexes and summary FTS in `0007_english_search_indexes.sql` (ADR-0030, ADR-0034, ADR-0035).
- **Enrichment:** jev for sentiment, OpenAI `gpt-4o-mini` structured output for summary/topics when keys present; otherwise realistic mock with origin `mock` (ADR-0003, ADR-0013). Daily budget deferral, never drop (ADR-0010). Circuit breaker per provider.
- **Schema:** Append-mostly articles; jobs / enrichments / derived_values ledgers; roles `app_ingest`, `app_worker`, `app_read`. See `db/migrations/0001_init.sql`.
- **UI:** Wireframe palette and states from `.specs/ux/`; custom SVG trends chart + table (ADR-0015).
- **Upload:** Open when `UPLOAD_ENABLED` (ADR-0037); size/rate/budget guardrails, no shared token.



### Golden queries (sample of 20)


| ID  | Query                                                    | Expected external ids                  |
| --- | -------------------------------------------------------- | -------------------------------------- |
| G1  | `"oil prices" AND (geopolitical OR "supply chain")`      | 1                                      |
| G2  | `renewable AND NOT (nuclear OR coal)`                    | 5                                      |
| G3  | `AI AND ("healthcare" OR "diagnostic") AND NOT startup*` | none (correct; startup excludes id 10) |
| G3a | `AI AND ("healthcare" OR "diagnostic")`                  | 10                                     |




## LLM Cost Analysis

With keys unset, cost is **$0** (mock). Numbers below use **published OpenAI list prices** (read 2026-10-28) and token estimates from the 20-article sample via the prompt builder — not a live billed run. Detail: `[reports/measurements.md](reports/measurements.md)`.


| Provider / model              | Tokens in (avg) | Tokens out (est.) | $/article      | 50k/day (0% cache) | 50k/day (30% cache) |
| ----------------------------- | --------------- | ----------------- | -------------- | ------------------ | ------------------- |
| OpenAI **gpt-4o-mini**        | ~338            | ~100              | **$0.000111**  | **$5.53**          | **$3.87**           |
| OpenAI gpt-5-nano (alt.)      | ~338            | ~100              | $0.000057      | $2.84              | $1.99               |
| OpenAI gpt-4.1-mini (alt.)    | ~338            | ~100              | $0.000295      | $14.75             | $10.33              |
| jev (sentiment), **measured** | 469             | 46                | **$0.0000197** | **$0.99**          | n/a (see below)     |


**Model choice (gpt-4o-mini):** cost stays under the default `$10` OpenAI enrich daily cap at 50k articles even with little cache; quality is enough for 1–2 sentence summaries and a closed topic enum with strict JSON schema; latency is low without a reasoning step. `gpt-5-nano` is cheaper but newer/less exercised here; `gpt-4.1-mini` costs ~3× for little gain on this short structured task. jev is kept for calibrated-style class probabilities; its docs do not publish prices, so spend is capped by the budget ledger and required `JEV_PRICE_`* when real.

**jev measured usage (2026-10-28):** 20 live sentiment calls on the sample corpus, all with provider-reported `usage` (none estimated or mock). Input averaged 469 tokens (min 409, max 612, p95 500) and output 46 tokens. At the configured `JEV_PRICE_IN_PER_MTOK=0.042` and `JEV_PRICE_OUT_PER_MTOK=0` that is about **$0.0000197 per article, or ~$0.99 per 50,000 classifications**, well inside the `BUDGET_JEV_DAILY` ($5) cap. Combined with the OpenAI summary/topics call (20 calls, avg 445 in / 103 out, $0.0001285 per article, ~$6.43 per 50k) the enrichment total is roughly **$7.40 per 50k articles**. Caveats: the sample articles are short (about 441 characters on average), so longer real articles will cost more; the figure is a floor, not a ceiling. jev input (headline + body) is deliberately truncated at 12,000 characters (about 3,000 tokens), which bounds the worst-case cost per call at roughly $0.00013 at the configured price. This cutoff is accepted for the purposes of the current task: sentiment is an overall-tone judgement that the opening of an article carries well enough, and the cap keeps spend predictable. The jev cutoff is not currently recorded per row (`input_truncated` is only set for the OpenAI path), so affected articles would have to be found by body length if the cutoff is revisited. Reproduce with `SELECT provider, part, count(*), avg(input_tokens), avg(output_tokens), avg(cost_micro)/1e6 FROM enrichments WHERE origin = 'provider' GROUP BY 1, 2;`.

Cache key: `sha256(prompt_version + text)`. Guardrails: daily caps (`BUDGET_*_DAILY`), per-call reserve, concurrency/RPM, attempts cap, breaker, kill switch (`enrichment_enabled`).

## Security & Responsibility


| Risk             | Control                                                                                                                                                           | Tests                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| SQL injection    | Bound parameters only; parser never concatenates user text into SQL                                                                                               | `tests/unit/parse.test.ts`                                              |
| XSS              | React text escaping; sanitiser strips markup; per-request nonce CSP for scripts (`src/proxy.ts`) with `style-src-attr 'unsafe-inline'` for a few style attributes | sanitiser unit tests; `tests/unit/csp-proxy.test.ts`; e2e `csp.spec.ts` |
| Prompt injection | Nonce-fenced prompts (headline + body); injection detector → `trust=low`; never drop                                                                              | `inject-detect.ts`, `prompt.test.ts`                                    |
| Cost abuse       | Budget ledger, deferral, caps                                                                                                                                     | worker budget path                                                      |
| Secrets          | Generated volume secrets; provider keys only on worker; `.gitignore` / `.dockerignore`                                                                            | devops D-T12 checklist                                                  |




## Reflection

This was an interesting project for me as I have mostly been building my own projects using a simplified workflow, so I wanted to see how far I could push it. To be honest, it was a bit daunting knowing that people would be looking at my chats, as although I know plenty of developers who now use AI, I don't exactly know how they approach prompting. It took me a little over 9 hours, but we went through some challenging family circumstances (our cat died) so given more focus I could probably have finished it in about 7-8.  

My personal workflow is a bit particular - I have a grandfathered Cursor account that rates usage by request rather than by token usage, so my strategy is usually to spec out as much as I can on a Claude Code subscription, using skills to orchestrate the design of different aspects of the requirements, and then to output them into one detailed execution document called a `plan`. This plan then becomes the input into Cursor, using Cursor's own planning function on the Auto model (because non-auto models use 2 requests, not 1). I then read the plan from Cursor and then execute it. Based on my current usage it comes out to around $200-$250 had I to use the token-based metering instead. By comparison to the Claude chats, the Cursor ones are rather dull.

It took me a couple of more hours to tinker with issues that cropped up, but they were minor by comparison. It was also interesting to work with documents from Arabic and Chinese, and the multi-lingual aspect was also baked into the core design principles. I also put some focus on making sure that the translation operations were working, and that foreign characters were also indexed and searchable.

I've also been meaning to use Jev for a while, and I found that it was a very cost-effective way to run sentiment analysis, around $1 for 50k invocations.  There are a few caveats so in a real scenario it would probably cost marginally more, but it was quite a good find and I'll be using it more whenever I need things like spam detection, classification with minor topics, etc. It also returns a confidence interval, which was one of the core design principles that highlighted the need to never present something as certain, but always with a degree of confidence, including where that confidence originated from. This equips analysts with the best tools to make their decisions when presenting info to clients.

Given that we couldn't use external search systems like ElasticSearch, I made the assumption that since we had PostgreSQL, we could install extensions on it to increase its capabilities. We used the following extensions:


| Extension            | Purpose                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_trgm`            | Trigram GIN index for substring and fuzzy search. It is the main search index for the literal-substring branch.                                       |
| `unaccent`           | Accent-insensitive matching. It is used in search text and in generated columns.                                                                      |
| `pg_stat_statements` | Finds the hot queries. It needs `shared_preload_libraries = 'pg_stat_statements'`, which is set in db/postgres/small.conf and db/postgres/bench.conf. |


The specs considered several other extensions and did not adopt them:

- `pgmq`**:** the project uses a `SKIP LOCKED` table as its queue instead.
- **Vector search:** not adopted.
- `pg_cron`**:** not used. Retention runs through a documented CLI.
- `pg_partman`**:** only mentioned as an option for creating future partitions. It is not in use.
- `pg_bigm` **and PGroonga:** named as growth paths for Chinese and Arabic search if `pg_trgm` turns out to be too weak.

Another overscope: I added a benchmark skill as well as provisions within the other skill to be able to support benchmarking, so that when making changes, we can actually benchmark parts of the code. Given that the dataset was very limited, and it would have probably taken some time to synthesise new articles at scale to make this worthwhile, I decided not to include this in the workflow. But it would make sense in an actual production setting.

All in all it was a great project, enjoyed it a lot :)

## Growth path (documented, not built)

Partitioning + `article_keys`, restrict trigram index, queue extension, vectors/tiered enrichment, relevance ranking, human review controls, OpenTelemetry. 800 articles/s is not claimed.

## Not proven

- 800/s throughput on this host
- 15-minute freshness SLO on live feeds (sample is backfill only)
- jev cost on production-length articles (measured on 20 short sample articles only); jev's published input limits

