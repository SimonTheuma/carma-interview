# Carma PoC: Core Design Principles

Oct 24, 2026 · @Simon

## Purpose and scope

These principles guide design and development decisions on the Carma proof of concept. Where two reasonable choices conflict, the principles decide.

The PoC is an internal tool. Its job is to prepare data and make it searchable. Client-facing presentation comes later in the pipeline, so principles that matter mainly at that stage are listed under deferred items rather than dropped.

Two principles come directly from our interview with Carma: information must be delivered quickly and reliably. The rest are derived from a review of Carma's public website (carma.com), plus two additions from our own team on confidence and methodology. The website is marketing copy, so the derived principles are inferences. For this exercise we assume Carma agrees with them.

Each principle has a statement, a reason, and what it means in practice. When a design or build decision touches a principle, note which one and how.

## Constraints and scope for this exercise

The PoC must run on PostgreSQL, without an event-driven platform, and handle about 800 articles a second. The table records that and the other decisions taken so far.

| Area | Decision |
| --- | --- |
| Latency target | A brand mention reaches a user within 15 minutes of the article's published\_at time, for every source and language. Insights are delivered daily or weekly and are not held to this target. Completeness takes priority: a late item is better than a missed one. |
| Input data | Articles only, each with id, headline, body, source, published\_at (UTC timestamp), and language. Other source types are out of scope for this exercise. |
| Backing store | PostgreSQL. Carma's internal limitations rule out an event-driven platform such as Kafka for now. |
| Volume | About 800 articles per second, roughly 69 million a day. Throughput is to be maximised, and capacity measured against this load. |
| Languages | English, Arabic, and Chinese for this exercise. The design must be able to handle any language. |
| Confidence scale | One 0 to 100% scale for every derived field. Scorers usually report on 0 to 1 or another range, so a min/max range is supplied per scoring source and values are normalised. |
| Fields needing confidence | Sentiment, relevance, topic, summary, and entity match. |
| Calibration | Out of scope for this exercise. Methodology transparency (P7) lets a human or agent decide whether a value is acceptable. |
| Evidence base | Carma's public website only. We have not seen the product or the client portal. |
| Carma's view of the principles | Assumed to agree, for the purposes of this exercise. |

## Principles at a glance

Eleven principles, grouped in the sections that follow.

1. **Fast.** Information reaches the people who need it with minimal delay.
2. **Reliable.** The system behaves predictably, and failures are never silent.
3. **Complete, and honest about gaps.** Coverage is broad, and what is not covered is visible.
4. **Signal over volume.** Relevance is part of speed; noise counts as a defect.
5. **Consistent across markets and languages.** Results are comparable wherever and in whatever language they originate.
6. **Every insight carries a confidence.** No item is presented without a degree of confidence attached.
7. **Confidence is inspectable.** We can work backwards to how it was calculated, and its origin is stated plainly.
8. **Everything traces to its source.** Any item can be followed back to the original content.
9. **Human judgment is part of the system.** Automation and people have defined, visible roles.
10. **Data leads to meaning.** Output explains what happened and why it matters, not only what was found.
11. **Fit the audience.** Content suits the person and situation receiving it.

## Foundational principles

These two came directly from the client interview and sit above everything else.

### P1. Fast

**Statement.** Information reaches the people who need it with minimal delay, from the moment an article is published to the moment a user can see it.

**Why.** Carma's value depends on telling clients what is being said before anyone else does. Late information loses most of its value, especially during a crisis.

**In practice.**

- Treat time from publication to searchable as a core measure, and track it per source type.
- Prefer approaches that make fresh content searchable first and enrich it afterwards.
- Show how fresh an item or index is. A user should never have to guess whether something is current.

**Target.** A brand mention reaches a user within 15 minutes of the article's published\_at time, for every source and language. Insights are delivered daily or weekly and are not held to this target. At about 800 articles a second, that budget is shared by ingestion, indexing, and enrichment, so each stage's share is measured. The clock starts at published\_at, when the item first appears in print, so any delay before Carma captures an article also counts. Capture lag is therefore measured separately from processing time. Completeness outranks speed: Carma's emphasis is on not missing a mention, so a late item is better than a missing one. Items that miss the target are flagged, not dropped.

**Under the PostgreSQL constraint.**

- Volume is about 800 articles a second with no streaming platform, so ingestion and indexing work in steady incremental batches. Measure freshness end to end, because delay can hide between batches.
- Keep the first searchable form of an item cheap, so enrichment never holds up search.

### P2. Reliable

**Statement.** The system behaves predictably, and when something fails, it says so.

**Why.** Clients rely on Carma for critical data. A missed or delayed item that nobody knows about is worse than a visible outage.

**In practice.**

- No silent failures. A broken source, a stalled pipeline, or a gap in ingestion is surfaced to the team.
- Ingestion is repeatable. Reprocessing the same content gives the same result and creates no duplicates.
- Where speed and reliability conflict, ship the item with a clear state (for example, "not yet enriched") rather than delay or drop it.

**Under the PostgreSQL constraint.**

- Without a message broker, retry and recovery depend on the database. Record each item's processing state so interrupted work resumes and stuck items are visible.
- If processing falls behind, report how far behind rather than quietly slowing down.

## Data principles

Carma's public positioning rests on coverage, relevance, and comparability. These principles protect each of them.

### P3. Complete, and honest about gaps

**Statement.** Coverage is as broad as we can make it across news, social, broadcast, print, and other sources, and what is not covered is visible.

**Why.** Carma stresses "complete data" across channels and 105+ languages. For a monitoring product, a missed mention is the most damaging failure, and it is invisible unless the system reveals it.

**In practice.**

- Record which sources and source types feed the index, and expose that to users.
- Make absence interpretable: "no results" should be distinguishable from "not covered" and "not yet processed".
- Treat coverage drops (a source going quiet) as events worth flagging.

**Priority.** Where the 15-minute target (P1) and completeness conflict, completeness wins. A mention that arrives late is still delivered, and is marked as late.

### P4. Signal over volume

**Statement.** Relevance is part of speed. Noise is a defect, not a neutral side effect.

**Why.** Carma's own materials argue that keyword-only alerting drowns users in content, and that filtering with expert judgment is the alternative. Fast delivery of irrelevant content is not useful delivery.

**In practice.**

- Deduplicate, filter, and rank as part of preparing data, not as an afterthought.
- Search results default to the most relevant items, with a clear way to widen.
- Filtering decisions are recorded, so removed content can be recovered and the filter judged.

### P5. Consistent across markets and languages

**Statement.** The same kind of content is processed and described the same way, whatever its market or language.

**Why.** Carma works across 105+ languages, including non-Latin scripts, and sells multi-market comparison. Comparisons only mean something if the underlying data is handled consistently.

**In practice.**

- Use one data model and one set of field definitions across all sources.
- Support multiple scripts and right-to-left text from the start. Carma's own site already serves Arabic.
- Where quality differs by language, say so (see P6 and P7), rather than presenting results as equally reliable.

**PoC scope.** English, Arabic, and Chinese are in scope for this exercise, but nothing may hard-code those three: any language should work through the same data model. Arabic is written right to left, and Chinese text has no spaces between words, so search and display must cope with both.

## Confidence and transparency principles

These principles were added by our team. Because the PoC is an internal tool, we accept more detail on screen than a client-facing product would show, in exchange for transparency.

### P6. Every insight carries a confidence

**Statement.** Any insight, classification, or derived item presented in the dashboard has a degree of confidence attached. No exceptions for items that seem obvious.

**Why.** Users need to know how far to trust each item before acting on it. Presenting derived output without confidence implies a certainty the system does not have. Showing it can be tedious, but this is an internal tool and the cost is acceptable.

**In practice.**

- Confidence is part of the data model for every derived field (for example sentiment, topic, relevance, summary, entity match), not a display option.
- Confidence is visible alongside the item by default. Users may collapse it, but cannot be unaware of it.
- Items without a computed confidence show "no confidence available", never a blank or an implied high value.
- Confidence on an aggregate (a chart, a trend) is stated separately from confidence on the items it summarises.

### P7. Confidence is inspectable, and its origin is stated plainly

**Statement.** For any confidence value, a user can work backwards to how it was produced. The stated reason is the real reason, even when that reason is unimpressive.

**Why.** A confidence number is only as useful as what stands behind it. If an LLM simply reported that it was 60% confident, the honest explanation is exactly that, and dressing it up as a calibrated probability would mislead. We aim for as much transparency as possible.

**In practice.**

- Every confidence value records its origin, the method that produced it, and the inputs used.
- Self-reported LLM confidence is labelled as such, for example "the model stated 60% confidence". It is never shown as a statistical probability.
- Where a value combines several signals, the components and the combining rule are visible, not only the result.
- Methodology descriptions are versioned. A past value can be traced to the method in force when it was produced.
- When the method changes, results stay comparable or are clearly marked as not comparable.

**Scale and readers.** Confidence is expressed on one 0 to 100% scale for every origin. Scorers usually report on 0 to 1 or another range, so each scoring source supplies a min/max range and values are normalised to 0 to 100%. The raw value, the range used, and the normalised result are all stored and visible. A 60 from a model's self-report and a 60 from a calibrated classifier mean different things, so the origin always travels with the number. Methodology must be readable by both human reviewers and automated agents, so either can judge whether a value is acceptable for their purpose.

The table below lists origin types we expect to distinguish. It is a starting point, to be refined as the PoC takes shape.

| Origin | Example | What must be stated |
| --- | --- | --- |
| Model self-report | LLM says it is 60% confident | That the figure is the model's own statement, plus the model and prompt version |
| Rule-based | Exact match on a known entity name | The rule that fired and the match it found |
| Statistical or classifier score | A classifier's probability output | The model, its version, and how the score was or was not calibrated |
| Human review | An analyst confirmed a sentiment label | Who or what role reviewed it, and when |
| Combined | Several of the above merged | Each component and how they were combined |

### P8. Everything traces to its source

**Statement.** Any item, summary, or insight can be followed back to the original content it came from.

**Why.** Clients use media intelligence to make reputational decisions and to report upward. Confidence and methodology (P6, P7) only help if the underlying evidence can be checked.

**In practice.**

- Every derived item stores references to its source items.
- Summaries and insights link to the specific content that supports them.
- Records show what was done to an item (translated, summarised, classified, deduplicated) and when.

## Judgment and insight principles

Carma presents itself as hybrid: automation for scale, people for interpretation. These principles carry that into the PoC.

### P9. Human judgment is part of the system

**Statement.** Automation and people have defined roles, and users can see which produced what.

**Why.** Carma's public message is that AI brings scale and humans bring judgment, and that it does not overstate what technology can do. A tool that hides where automation ends would undercut that.

**In practice.**

- Design explicit points where an analyst can review, correct, or override automated output.
- Mark each derived item as automated, human-reviewed, or human-authored. This feeds directly into the origin of its confidence (P7).
- Corrections are captured and kept, so they can improve later processing.

### P10. Data leads to meaning

**Statement.** Output helps users understand what happened and why it matters, not only what was found.

**Why.** Carma contrasts itself with providers that hand over a login and leave the interpretation to the client. Even in a data-preparation PoC, the data should be shaped to support explanation.

**In practice.**

- Enrich content with the context interpretation needs: topic, entities, sentiment, and relationships between items.
- Search supports questions about change (what shifted, and since when), not only retrieval of matching items.
- Raw detail remains one step behind any summary (see P8).

## Audience-aware delivery

This principle matters less to the PoC than the others, but it shapes data modelling choices made now.

### P11. Fit the audience

**Statement.** Content is shaped for the person and situation receiving it: urgent or routine, analyst or executive.

**Why.** Carma delivers through many channels and formats, from crisis alerts to daily briefings, and its clients include senior readers outside communications teams. The same item may need different treatment for each.

**In practice.**

- Model data so that urgency, audience, and market can be filtered and derived later.
- Do not build for one assumed user. The PoC's internal users are analysts, but their output will reach others.
- Design interfaces for scanning and fast decisions, since users are often under time pressure.

## Deferred for later in the pipeline

One principle from our review of Carma's site is out of scope for the PoC and is recorded here so it is not lost.

- **Shareable by default.** Carma's outputs are built to leave the platform: executive briefings, branded newsletters, ready-made reports, and exports. Preparing data and making it searchable comes first, so presentation and export design are revisited at the stage where outputs reach clients. Data modelling choices today should not make that harder (see P11).
