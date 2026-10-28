---
adr: 0003
title: jev for sentiment, an OpenAI small model for summary and topics, behind one provider interface
status: accepted
date: 2026-10-24
decision-makers: [simon@mavericks.mt]
raw-spec: ../0001-media-signal-service.md
supersedes: null
---

# ADR-0003: Enrichment providers

## Context and problem statement
The brief asks for a summary, a sentiment class and 1 to 3 topics per article, with model choice justified on cost, quality and latency. The user will supply API keys and chose jev (TypeSafe) for sentiment and an OpenAI small model for summary and topics.

## Decision drivers
- P6 and P7: every derived value needs confidence, origin, method and range
- Cost at 50,000 articles a day
- Prompt-injection surface: untrusted text goes to both providers

## Considered options
1. jev (sentiment) + OpenAI small model (summary, topics)
2. One OpenAI call for all three
3. Mock only

## Decision outcome
Chosen option 1, behind a provider interface. A mock adapter stays for tests and for graders without keys (UNCONFIRMED: user to confirm; origin recorded as `mock`).

Facts from the jev docs (https://docs.typesafe.ai/introduction, `/introduction/quickstart.md`, `/confidence.md`, read 2026-10-24):
- `POST https://api.typesafe.ai/v1/systemone`, Bearer key, body `{state, model, questions}`; model id `jev-latest` (response reports a version such as `jev-1.13.0`).
- A Choice question returns `choice`, `probabilities` and `confidence`. Confidence is 0 to 1 and summarises how concentrated the probabilities are: (p_max − 1/n) / (1 − 1/n). The docs do not claim it is calibrated.
- The docs do not state pricing, rate limits or input limits. These are unknowns for the cost analysis.

Mapping: sentiment is one Choice question over `positive | negative | neutral | mixed`. Stored per row: choice, per-class probabilities, raw confidence (0 to 1), range 0 to 1, normalised 0 to 100, origin `classifier_concentration`, model version from the response. This confidence means "how decisive", not "how likely to be right", and the UI must say so (P7).

Summary and topics: one call to the OpenAI model with structured output, topic enum from the controlled list (D4 default). **Default assignment model: `gpt-4o-mini`** (`OPENAI_MODEL`), recorded per enrichment row. Chosen over cheaper `gpt-5-nano` and dearer `gpt-4.1-mini` for stable structured-output behaviour, low latency, and cost that stays under the default `$10` daily OpenAI enrich cap at 50k articles/day with modest cache (see `reports/measurements.md`, prices from OpenAI list rates read 2026-10-28).

Confidence for summary and topics comes from the model's self-report, origin `llm_self_report`, never shown as a probability.

Cost analysis: OpenAI side is filled from published list prices and estimated tokens on the sample corpus. jev list price remains unknown; spend is gated by `BUDGET_JEV_DAILY` and required `JEV_PRICE_*` env when real.

### Consequences
- Good: sentiment gets real probabilities; two providers show a deliberate cost/quality split in the README.
- Bad: two dependencies means two breakers, two budgets and two failure paths; an enrichment is only complete when both parts arrive. A job tracks the two parts separately so one outage does not block the other.
- Risks: jev pricing and limits unknown; its `mixed` class must be expressible in the rubric; text sent to two third parties.

### Confirmation
Tests FP-10 to FP-14 per provider; budget ledger per provider; README + `reports/measurements.md` cost tables for OpenAI; jev still price-unknown.
