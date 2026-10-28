---
name: "carma-searchability"
description: "Designs how Carma article data is made searchable and analysable, building on the carma-architect output, including the analytical layer behind reports."
---
 
# carma-searchability
 
Search is the product's core job: data is prepared so that it can be found, and it will be searched constantly. A missed mention is the most damaging failure Carma has (P3), so this skill designs for recall first and speed second, then makes the cost of that choice visible.
 
Finding articles is half the job. Carma's reports also slice a set of articles into counts, shares, trends and rankings, and the reader has to be able to trust those numbers. The analytical layer is designed here too, because it decides what has to be stored and indexed at ingestion and cannot be retrofitted cheaply.
 
Read `references/carma-context.md` first for the principles, constraints and spec conventions. The Appendix at the end of this file is a checklist of the data points, grains and report patterns that analysis needs; use it as a checklist and extend it when the feature brings new report types.
 
## Inputs
 
Read the latest non-superseded `.specs/architect/NNNN-*.md` for this feature and the ADRs that reference it. You need: what is searched, by whom, how often, the data flow and states, and the failure and hot path registers (FP/HP). If there is no architect spec, ask the user to run carma-architect or, for a small request, run its analysis inline and say so.
 
First check applicability. If no requirement involves finding, filtering, matching or aggregating content, say that search design is not needed and stop. Do not invent a search problem.
 
## Workflow
 
### 1. Separate the three kinds of search
 
They look similar and have different cost profiles, so design them separately.
 
- **Ad hoc search.** An analyst types a query against the stored archive. Latency of seconds is fine, but queries are varied and frequent.
- **Standing queries.** Saved brand and keyword definitions that must be evaluated against every incoming article so mentions reach users within 15 minutes of `published_at` (P1). At 800 articles a second this is a reverse-search problem: the cost grows with the number of saved queries times arrivals. Matching at ingestion beats re-scanning the archive.
- **Analytical queries.** Report and dashboard questions: "what share of each market's coverage mentions X", "volume by month split by sentiment", "who was quoted most, and how negatively". They read many articles and return few numbers. Cost is driven by the number of articles in scope and the number of dimensions, so they are served from structures prepared at ingestion (step 7), not by scanning text.
For each, write down: who uses it, expected volume, acceptable latency, and the cost of a false negative versus a false positive. Carma's stated emphasis is not missing a mention, so false negatives cost more. Say so, then design for high recall with precision handled by ranking and review (P4), not by narrowing the match. For analytical queries the equivalent risk is a number that is wrong without looking wrong, so the cost to state is "a plausible but incorrect figure reaches a client".
 
Name the analytical questions the feature must answer. Take them from the requirements, and from the report patterns in the Appendix (section C). Each question later becomes a test (step 11).
 
### 2. Define the searchable document
 
List exactly what is indexed per article: `headline`, `body`, `source`, `published_at`, `language`, plus derived fields such as entities, topics and sentiment. For derived fields, carry their confidence and origin (P6, P7) so results can be filtered or ranked by them. State which fields are searched as text, which are filters, and which are only displayed.
 
Keep the extracted text as stored (raw markup is not retained by default). Normalised or tokenised forms are derived from it so they can be rebuilt when the method improves, and a result can always be traced to what was published (P8).
 
Headline and body are separate searchable fields. Some analysis is about the headline alone (emotive wording, "named in the headline"), and matching the body for those questions gives wrong answers.
 
### 3. Tokenization and normalisation, per language (P5)
 
The same data model must serve every language. Design a language-aware analysis step and a safe fallback, rather than special cases scattered through queries.
 
- **English and similar.** Case folding, stemming or lemmatisation, stop words. Decide whether brand names and short tokens (for example "AI") bypass stop words, because aggressive stop-word lists silently lose mentions.
- **Arabic.** Right-to-left. Normalise before indexing: strip diacritics and tatweel, unify alef and ya/alef maqsura variants, handle taa marbuta variation, and decide on light stemming. Prefixed articles and conjunctions attach to words, so a brand name inside a longer token must still match. Mixed Arabic and Latin text in one article is normal.
- **Chinese.** No spaces between words, so whitespace tokenisation finds nothing. Options: dictionary-based segmentation (accurate, needs a segmenter and a maintained dictionary, and brand names missing from it get split wrongly) or character n-grams (bigrams are a robust recall-first baseline, larger index). Simplified versus Traditional script variants may need conversion. Full-width and half-width forms need normalisation.
- **Any other language.** A documented fallback: Unicode normalisation (NFKC), case folding, and a language-agnostic tokenizer, with the article's `language` field and a detected language used to route it. State how the fallback behaves for scripts it cannot segment and how that shows up in coverage reporting.
Always apply one Unicode normalisation form consistently at index and query time. Mismatched normalisation is a classic reason a mention that is visibly there is not found.
 
Treat the `language` field as a claim, not a fact. Plan for a mismatch with the detected language and say what happens to those articles (still indexed, and flagged).
 
### 4. Entities, aliases and quotes
 
Brand and person mentions are the main thing Carma users search for and aggregate on, so entity handling is part of search, not an extra.
 
- **Entity resolution.** Each entity has a canonical id, a type (organisation, product, person, place), aliases per language, abbreviations, known misspellings, and links to parents and subsidiaries. Company and product are separate entities with a link (a product and its maker, a brand and its parent). Joint names ("A-B") must resolve to both. Expect spelling variants, abbreviations, two names for one organisation, and the same entity written differently in each language.
- **Match confidence (P6).** Resolution to an entity id carries a confidence and origin. Unresolved or low-confidence mentions stay findable by plain text; they are never dropped (P3).
- **Time-varying attributes.** Some entity facts change over time (a role, a status, a launch date). Store them with validity dates so "before launch" and "while CEO" can be asked.
- **Quotes as records.** A quote has its own text, speaker (entity), speaker role and type, polarity, topic, and span in the article. Quote text is searchable on its own. This is what allows "who was quoted most", "most negative speakers" and "what did X say about Y".
### 5. Indexing strategies on PostgreSQL
 
Present options with trade-offs and a recommendation, and check what the codebase and environment actually allow (version, extensions) before leaning on any of them. Candidates:
 
- Full-text search with `tsvector`/`tsquery` and GIN, using a text-search configuration per language where one exists and a `simple`-style configuration otherwise. Weigh storing the vector (fast query, bigger writes) versus computing it on the fly.
- Trigram matching (`pg_trgm`) for fuzzy names and misspellings; consider its fit for short strings and its index size.
- n-gram or bigram approaches for CJK where the built-in parser cannot segment.
- Extensions or an external search engine are possible but may not be allowed in Carma's environment. Name them as options for the user to rule in or out; do not assume them.
Indexing cost competes with ingestion throughput. Note where index maintenance sits on the write hot path and hand that concern to carma-dba explicitly.
 
### 6. Bucketing and partitioning
 
Bucketing exists so most queries touch a small slice of the data.
 
- **Time buckets** by `published_at` (hour or day) fit append-only data, allow cheap retention by dropping whole buckets, and match the recency bias of most queries. Consider hot, warm and cold tiers with different index richness: the newest bucket may carry lighter indexes so items become searchable sooner (P1), with fuller indexes built as it ages.
- **Language buckets** where analysis differs by language. Weigh the benefit of per-language indexes against the cost of cross-language queries.
- **Source buckets** only if source-scoped queries are common and the cardinality is manageable.
- **Standing-query buckets.** Group saved queries by shared terms so an incoming article is checked against a candidate set instead of every query: an inverted map from term to queries, or a multi-pattern matcher, followed by verification of the candidates.
For each bucketing choice state the query patterns it helps, the ones it hurts (cross-bucket queries), and the operational cost.
 
### 7. Analytical layer: grains, facets and aggregates
 
This step makes reports possible. Work from the Appendix and from the analytical questions named in step 1.
 
**7a. Grains.** List the grains the feature needs (article, headline, entity mention, quote, attribute reference, tag, event, external observation) and for each the fields, whether it is multi-valued, and which fields are derived. One article produces many child records, so they are separate tables or partitions linked to the article by id, never columns or arrays on the article row when the analysis counts them. State the expected child records per article, because that multiplies write volume at 800 articles a second. Hand that figure to carma-dba.
 
**7b. Dimensions and measures.** For each question list the dimensions to group and filter by, and the measures (count at which grain, share of which base, score, rank, trend). For every share, write the numerator, the denominator and the grain of each. If a question cannot name its denominator, it is not yet well defined: raise it as a decision.
 
**7c. Vocabularies and groupings.** Topics, concerns, attributes, commentator types and similar sets are controlled vocabularies: versioned data with labels per language, not code. Every coded value stores the vocabulary version. Region groupings are named, versioned sets of markets and may overlap; one market can sit in several groups.
 
**7d. Scope.** A scope is a saved, versioned definition: markets, outlets or tiers, interval (half-open, with a stated time zone rule), topic query, and whether it covers the full population or a sample. Every aggregate and every report cites its scope id. The same scope on the same data and vocabulary versions must give the same number.
 
**7e. How aggregates are served.** Present options with trade-offs and a recommendation:
- Compute on demand from the child records, using partition pruning and covering indexes. Simple and always exact; slow when scopes are large.
- Incremental rollups maintained at ingestion at the finest grain needed (for example day by market by entity by category by polarity), then rolled up for coarser views. Fast; adds write cost and a reconciliation need.
- Materialised views refreshed on a schedule. Cheap to build; stale between refreshes, so staleness must be shown.
- Extensions or an external column store. Name as options for the user to rule in or out.
Pick per question, not globally. Rollups must be rebuildable from the child records so a corrected coder or vocabulary can be re-applied (P8). Hand rollup maintenance cost to carma-dba and its reconciliation to carma-backend-testing.
 
**7f. Drill-through invariant.** Every aggregate must be turnable into the list of records that produced it, and the list size equals the count. Rollups therefore keep the keys or the scope needed to regenerate the list. Say how this works for each rollup (P8).
 
**7g. Honest numbers.** Design these in, do not leave them to the interface:
- Carry the base count (n) with every rate. Flag low n; do not hide small groups (P3).
- Carry enrichment coverage: of the articles in scope, how many have the coded field computed, and how many are low confidence or unresolved. A share computed over 40% of the scope must say so (P3, P6).
- Say whether numbers come from the full population or a sample.
- Store the comparison set and tie rule with every rank.
- Keep positive and negative counts separate; do not store only a signed net.
- Say what a score is about and its scale: sentiment toward a stated proposition versus general tone, with min, max and the meaning of the midpoint (P7).
**7h. External series and events.** Survey results, search-interest indexes and event annotations are stored apart from article data, labelled with source, market, term or question, wave or date, sample size and scale. Indexed series are comparable only within one pull. They join to article aggregates by market and time bucket; they never get written into article tables. Decide whether external data is in scope at all (decision for the user).
 
**7i. Time handling.** Choose the finest bucket needed (usually day), roll up to week and month, and state the time zone rule for month and day boundaries, because UTC and local boundaries put different articles in different buckets.
 
### 8. Ranking, relevance and confidence
 
Ranking must serve P4 (signal over volume) without hiding anything (P3). Combine text relevance, recency, and optionally source or entity weights. A relevance score from the database's ranking functions is not calibrated, so when it is shown it is expressed on the 0 to 100% scale with its origin and min/max range stated (P6, P7), and the interface can say "database text-rank score, uncalibrated". Never imply it is a probability.
 
Ranking entities in an analytical view (most quoted, highest share positive) is different from ranking articles; it follows rule 3 in the Appendix: state the comparison set, the minimum n, and the tie handling.
 
### 9. Deduplication and near-duplicates
 
Wire stories republished across outlets create near-duplicates. Cluster them (for example with content fingerprints) but keep every copy and the link between them. Collapsing in the results view is fine; deleting is not, because each source's copy is a distinct mention (P3, P8).
 
Decide, per analytical measure, whether duplicates count once or each time. A syndicated story in ten outlets is ten mentions but one story, and the report's number changes depending on the answer. State it in the measure's definition.
 
### 10. Freshness and coverage signalling
 
Search must tell the user the truth about what it can see. Design the index watermark (the `published_at` or ingest time up to which everything is searchable), per-language and per-source coverage, and the three distinct empty states: no match, not covered, not yet processed (P3). Define how the answer to "is this complete?" is computed.
 
Analytics adds a fourth state: **not yet enriched**. An article can be searchable before sentiment, entities or quotes are computed (P1), but aggregates over those fields only see enriched articles. Every aggregate reports its watermark and its enrichment coverage, so a number over a half-enriched hour is not read as final.
 
### 11. Recall, precision and aggregate evaluation plan
 
Without measurement, "high recall" is a hope. Specify a labelled evaluation set: planted mentions in English, Arabic and Chinese including inflected, prefixed, misspelled, transliterated and mixed-script variants, plus articles that should not match. Define target recall for standing queries, how it is measured per language, and how regressions are caught when a tokenizer or dictionary changes. This feeds carma-backend-testing.
 
Add, for the analytical layer:
- **Coded-field accuracy.** A human-coded gold set per coded field (sentiment, topic, concern, commentator type, emotive headline, entity resolution, attribute and polarity). Define agreement targets per field and per language, and who codes it. A human-coded sample of articles, as Carma analysts produce for reports, is the natural source.
- **Aggregate correctness.** Known-answer tests: seed a small corpus where every expected count, share and rank is known, and check the aggregates exactly. Check the drill-through invariant on every rollup.
- **Aggregate stability.** How far does a headline number move when the coder, vocabulary version or model changes? Report that sensitivity so a change is a decision, not a surprise.
- **Rollup reconciliation.** Rollups equal a recount from the child records, within a stated tolerance and lag.
### 12. Decisions to put to the user
 
Raise choices that need a human: precision versus recall at the margin, index size versus write speed, segmentation method for Chinese, whether extra extensions or an external engine are acceptable, how much staleness a search may tolerate. For the analytical layer, also: which analytical questions are in scope, how duplicates count, full population or sampled enrichment (cost versus coverage), what the sentiment scale means and its range, whether external series are in scope, the time zone rule, the minimum n before a rate is flagged, and which controlled vocabularies exist and who owns them. Use the protocol in the context file.
 
## Output
 
Write the spec with these sections:
 
1. **Summary and applicability**
2. **Search use cases** (ad hoc, standing and analytical: users, volume, latency, false-negative cost; the analytical questions named)
3. **Searchable document** (fields, roles, derived fields with confidence)
4. **Language analysis plan** (English, Arabic, Chinese, fallback; normalisation; language mismatch handling)
5. **Entities and quotes** (resolution, aliases, match confidence, quote records)
6. **Index strategy** (options, recommendation, environment checks)
7. **Bucketing and partitioning** (scheme, tiers, standing-query grouping)
8. **Analytical layer** (grains and child records per article, dimensions and measures with numerator and denominator, vocabularies and groupings, scope definition, how aggregates are served, drill-through invariant, honest-number rules, external series, time handling)
9. **Ranking and confidence presentation**
10. **Deduplication** (including how duplicates count in each measure)
11. **Freshness and coverage signalling** (including enrichment coverage)
12. **Recall, precision and aggregate evaluation plan**
13. **Risks and hot paths** (extend the architect FP/HP registers with `FP-S` and `HP-S` entries, same columns; include child-record write amplification and rollup maintenance)
14. **Handoff** (what carma-dba must implement, what carma-telemetry must measure, what carma-backend-testing must verify, what carma-ux must show)
15. **Decisions needed and open questions**
In the handoff, be specific for the analytical layer:
- carma-dba: child record tables and their rate per article, rollup tables and refresh, vocabulary and scope tables, external series tables, retention per grain.
- carma-telemetry: enrichment coverage per field, rollup lag, aggregate query latency, drill-through count mismatches.
- carma-backend-testing: known-answer aggregate tests, rollup reconciliation, coded-field accuracy against the gold set.
- carma-ux: show n, enrichment coverage, scope and comparison set next to every figure; drill-through from every bar and number; low-n flags.
## Persisting the work (when run inside a codebase)
 
Follow "Spec conventions" in the context file. Number with `python scripts/next_spec_number.py .specs/search`, write `.specs/search/NNNN-<feature-slug>.md` with `spec: carma-searchability` front matter and list the architect spec under `inputs`. Edit in place while `draft`. Do not write ADRs yourself: when the user decides a search-design question, tell them it should be recorded and suggest running carma-architect to codify it as an ADR in `.specs/architect/adrs/`.
 
If you are not in a codebase, deliver the output in the conversation and offer to save it.
 
## Appendix: analytical data points checklist
 
Use this to check that the design can answer typical Carma report questions. Examples are generic; replace them with the feature's own entities and vocabularies. In reports the coded fields are often produced by human analysts. In the PoC they are derived automatically, so each carries confidence and origin (P6, P7) and can be overridden by a person (P9).
 
### A. Grains: the units that get counted
 
One article can hold many mentions, quotes and references, so these are separate records linked to the article. A percentage is only meaningful when the grain of the numerator and the denominator is stated.
 
| Grain | Example measure | Why it is its own record |
| --- | --- | --- |
| Article | Share of a market's coverage that mentions a theme | Base unit and the usual denominator. |
| Headline | Share of headlines that are emotive rather than factual | A property of the headline text; headline and body can disagree. |
| Entity mention | Articles mentioning a brand, with sentiment toward it | Many entities per article, each with its own sentiment. |
| Quote | Who was quoted, how negatively, about what | Each has a speaker, speaker type, polarity and topic. Many per article. |
| Attribute reference | Positive and negative references to a quality (such as competence) for one brand | Counts references, not articles; one article can hold several. |
| Topic or theme tag | Number of times a theme appeared | Multi-label per article. |
| Concern or issue tag | Share of articles with at least one concern | Multi-label; reported as "at least one". |
| Event annotation | A dated event that explains a peak | An annotation layer on the time axis, not an article attribute. |
| External observation | Search-interest index, survey wave result | Not article data; joined by market, time and term. |
| Scope | The saved definition of what a report covers | Makes a number reproducible. |
 
### B. Fields per grain
 
"Multi" means several values per record. "Derived" means produced by enrichment and carries confidence and origin.
 
- **Article and source:** market, outlet, outlet tier, language (stored and detected), `published_at` and its day, week and month buckets, article-level sentiment (derived; state what it is toward, its scale and its midpoint), in-scope flag, sample flag.
- **Headline:** emotive or factual (derived), entities named in the headline (multi).
- **Entity mention:** entity id, type, role, match confidence, per-entity sentiment (derived), time-varying attributes with validity dates, parent and subsidiary links, prominence (headline, lead, passing).
- **Quote:** text and span, speaker entity, speaker role, speaker type (for example government, expert, company, public), polarity (derived), topic (multi), the organisation the speaker represents.
- **Attribute reference:** attribute (from a configurable vocabulary), polarity, entity it is about, sub-issue (multi).
- **Tags:** theme and concern, from versioned vocabularies, with co-occurrence derivable.
- **External series and events:** value, market, term or question, date or wave, sample size, scale, source; event date, text, market or global.
### C. Report patterns and the query each needs
 
| Pattern | Query shape | Design consequence |
| --- | --- | --- |
| Percent of each market's coverage featuring X | count(articles with X) / count(articles in market within scope) | The denominator is a defined, queryable set with its own count. |
| Distribution across categories by region | group by region and category, normalised within region | Regions are overlapping groupings. |
| Volume over time split by sentiment | time bucket by polarity | Time-bucketed aggregates must be cheap. |
| Top speakers by negative quotes | group by speaker where polarity is negative, order, limit N | Speakers are entities; quotes are records. |
| Entity scorecard | per entity: counts by attribute and polarity, by region and market | Cross-tab of three dimensions, with n shown. |
| Rank of entities by share positive | proportion within a stated comparison set | Store the set, the minimum n and the tie rule. |
| Coverage against an external series | two series on one time axis | Align buckets and time zones; keep external data separate. |
| Coverage against survey waves | article aggregate per wave window against a survey value | Wave windows are scope definitions. |
| A peak explained by an event | bucket totals with nearby events | Event layer keyed by date and market. |
| Show me the articles behind this number | any aggregate to its record list | Drill-through must always work (P8). |
| Find what a person said | quote text by speaker, topic, date | Quote text is full-text searchable on its own. |
 
### D. Rules
 
1. **Every number states its grain and its denominator**, and gives the base count.
2. **Small bases are shown, never hidden.** A high percentage on four references is flagged, not removed (P3).
3. **Ranks are relative to a stated set.** The same entity ranks differently among all entities and among a subset. Store the set and the tie handling.
4. **Aggregates drill through.** Every count can be turned into the records that produced it, and the list size equals the count (P8).
5. **Scope is a saved, versioned definition.** Markets, outlets or tiers, topic query, and a half-open interval with a stated time zone. Reports often state their period two different ways; design that ambiguity out.
6. **Say whether a figure covers the full population or a sample**, and report enrichment coverage next to it (P3, P6).
7. **Controlled vocabularies are versioned data with labels per language.** Store the vocabulary version on each coded value (P5, P7).
8. **Region groupings overlap.** One market can be in several named groups; do not force a hierarchy.
9. **Entities need alias and hierarchy handling in every language**, with a match confidence (P6). Unresolved mentions stay findable by text.
10. **A sentiment score is toward something.** Store what it is about, its scale, min, max and the meaning of the midpoint (P7).
11. **Polarity counts are stored separately.** Volume and proportion both matter, and a signed net hides volume.
12. **External series are stored apart and labelled.** An indexed series is comparable only within one pull. A survey result carries wave dates, sample size and question wording.
13. **Time grain matters.** Pre-compute the finest grain needed (usually day) and roll up; state the time zone rule for boundaries.
14. **Headline and body are separate searchable fields.**