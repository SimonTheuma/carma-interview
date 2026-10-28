# Measurements

## Sample corpus (20 articles, Docker Desktop, 2026-10-24)

| Check | Result |
| --- | --- |
| Seed | received 20, admitted 20 |
| Enrichment (mock) | 20 sentiment + 20 summary_topics → succeeded |
| Weekly aggregate (no text filter) | 1, 3, 3, 6, 6, 1 |
| Monthly aggregate | 8, 12 (see `/api/aggregate?bucket=month`) |
| G1 | external_id 1 |
| G2 | external_id 5 |

## LLM cost estimates (list prices, 2026-10-28)

Sources: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) (standard text rates, read 2026-10-28). Token counts are **estimates** from `estimateTokens` in `src/lib/enrich/prompt.ts` over the 20-article sample (avg body+headline ≈ 441 chars). No live provider keys were used for this table.

### OpenAI summary + topics (one call per article)

| Item | Value |
| --- | --- |
| System prompt | ~208 tokens |
| Avg input (system + fenced article) | ~338 tokens |
| Estimated output (structured JSON) | ~100 tokens |
| Default model | `gpt-4o-mini` |
| List price in / out | $0.15 / $0.60 per 1M tokens |

| Model | In $/M | Out $/M | $/article | 50k/day (0% cache) | 50k/day (30% cache hit) |
| --- | --- | --- | --- | --- | --- |
| **gpt-4o-mini** (chosen) | 0.15 | 0.60 | **$0.000111** | **$5.53** | **$3.87** |
| gpt-5-nano | 0.05 | 0.40 | $0.000057 | $2.84 | $1.99 |
| gpt-4.1-mini | 0.40 | 1.60 | $0.000295 | $14.75 | $10.33 |

Formula: `tokens_in/1e6 * price_in + tokens_out/1e6 * price_out`.  
Cache key: `sha256(prompt_version + text)` — identical re-ingests skip the call.  
Daily OpenAI enrich cap: `BUDGET_OPENAI_DAILY` (default **$10**) stops new spends once reserved+spent hit the ledger; translate is additive (`BUDGET_TRANSLATE_DAILY`, default $3).

### jev sentiment

TypeSafe / jev docs do not publish list prices or input limits (ADR-0003). Cost is controlled by `BUDGET_JEV_DAILY` (default **$5**) and `JEV_PRICE_*_PER_MTOK` when a key is set. Without a price, the worker cannot run jev in real mode.

### Mock mode

With keys unset, enrichment uses the labelled mock adapter: **$0**.

### Not run in this environment (optional / heavy)

- M-KEYSET-1 / M-TRGM / 1 M-row generator (tools/gen) — track F COULD soak deferred to grader hardware time budget
- Real-provider M-COST-1 (measured tokens from live responses) — optional once keys are present; replace estimates above with response `usage` fields
