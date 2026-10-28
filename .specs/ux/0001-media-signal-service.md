---
spec: carma-ux
number: 0001
title: Search, trends, article and status screens for Media Signal Service
status: draft
date: 2026-10-24
feature: media-signal-service
inputs:
  - .specs/architect/0001-media-signal-service.md
  - .specs/search/0001-media-signal-service.md
  - .specs/data/sanitization/0001-media-signal-service.md
  - .specs/data/dba/0001-media-signal-service.md
  - .specs/telemetry/0001-media-signal-service.md
principles: [P1, P3, P5, P6, P7, P8, P9, P10, P11]
supersedes: null
---

# UX specification

## 1. Summary

Four screens, one shared filter state held in the URL:

1. **Search** (`/`): a boolean query box, filters, and a keyset-paginated list of article cards with AI summary, sentiment badge, topic tags and a confidence figure beside each derived value.
2. **Trends** (`/trends`): counts per week (or month) for the same query and filters, as a chart with an always-available table, optionally split by sentiment, language or topic. Clicking a bar opens the Search screen on exactly those articles.
3. **Article** (`/articles/[id]`): full text as inert text, what was done to it, derived values with "Why this number?", and the processing trail. This is also the developer's trace view.
4. **Status** (`/status`): ingest reconciliation, job backlog, budget, breaker state, quarantine.

The assignment says the UI "does not need to be beautiful, functional and clear is sufficient". This spec therefore prescribes content, states and behaviour, and keeps visual design out. Honesty is the design theme: every figure shows its coverage, every derived value shows its confidence and origin, every empty result says which kind of empty it is.

## 2. Users and core intents

| Rank | Role | Intent | Notes |
| --- | --- | --- | --- |
| 1 (primary) | Analyst | "Find the articles that mention a topic or brand with boolean logic, and judge whether the AI labels can be trusted." | Decides the layout: query first, results as scannable cards, confidence visible |
| 2 | Analyst | "See how coverage of this subject moves over time, and by sentiment, then open the articles behind a spike." | Trends screen, drill-through |
| 3 | Developer / reviewer | "Find out what happened to one article: what was removed from it, which provider labelled it, and what it cost." | Article screen |
| 4 | Operator | "Is the pipeline healthy, and is my data complete?" | Status screen |

Secondary intents must not compete with the primary: the Status link is in the header but nothing on Search is about operations except banners when enrichment is paused.

## 3. Approaches considered

| Option | Pros | Cons |
| --- | --- | --- |
| A. Separate routes (Search, Trends) sharing a URL-held filter state (recommended) | Drill-through is a plain link; back button works; any state is shareable; each page stays simple | A little duplicated header and filter code |
| B. One page with tabs | One filter bar, no navigation | Tab state, back-button and deep linking need extra work; long page |
| C. Dashboard-first with the chart on top of the list | Compact | Competes with the primary intent; chart refreshes on every keystroke |

Recommendation: **A**. The query and filters live in the URL query string (`?q=...&from=...&to=...&source=...&lang=...&sentiment=...&topic=...&bucket=week&split=sentiment`), which is also the source of truth for the screen, so reload and share work, and the Trends bar click is a link with a narrower date range.

Query submission model: results run on **Enter / Search button**, not on every keystroke, because half-typed boolean queries are usually invalid. Filters apply on change (debounced). The query is validated on the client while typing with the same pure parser module the server uses (no network), so errors show instantly with the position; the server remains authoritative.

## 4. Information architecture

```
Header:  [Media Signal]  Search | Trends | Status        (banner area below: enrichment paused, budget, provider outage)
/                 Search:   QueryInput, ParsedEcho, FilterBar, CoverageLine, ResultList, LoadMore
/trends           Trends:   QueryInput (same), FilterBar (same), TrendControls, TrendChart | TrendTable, CoverageLine
/articles/{id}    Article:  Header, FullText, ProcessingTrail, DerivedValues, Provenance
/status           Status:   tiles, jobs, budget, breakers, reconciliation, quarantine
```

Links between screens: card headline to Article; "View trends for this search" on Search to Trends (state carried); bar on Trends to Search (date range and series filter carried); Article source and language chips to Search with that filter.

## 5. Page specifications

### 5.1 Search (`/`)

**Purpose:** answer "which articles match, and can I trust the labels?".

**Layout hierarchy (top to bottom):**

1. Banner area (only when needed).
2. `QueryInput` with a Search button and three example chips (the assignment's examples), plus the `ParsedEcho` line directly under it.
3. `FilterBar`: date range (UTC), source (multi-select with a filter box), language, sentiment, topic.
4. `CoverageLine`: "20 articles in scope · 18 with sentiment · 18 with topics · data up to 14 Jul 2026 08:30 UTC".
5. Result count and a link "View trends for this search".
6. `ResultList` of `ArticleCard`s, then `LoadMore`.

**Data per card:** see section 6 `ArticleCard`.

**States (the page and the list):**

| State | Trigger | What the user sees |
| --- | --- | --- |
| First load | No previous results | Skeleton cards shaped like real cards; query box usable immediately |
| Refreshing | New query or filter while results exist | Previous results stay visible, dimmed, `aria-busy="true"`; a thin progress indicator appears only after 150 ms; no layout jump |
| Results | At least one match | List, count, `LoadMore` if another page exists |
| Empty: **no match** | Articles exist for the date, source and language filters, but none match the text (and derived filters) | "No articles match this query. Try fewer terms, check the parsed query above, or widen the date range." Offers the parsed echo again |
| Empty: **not covered** | Zero articles pass the date, source and language filters | "No articles in the corpus for these filters. The corpus holds {total} articles from {first} to {last} (UTC)." Does not suggest the query is wrong |
| Empty: **not yet processed** | A sentiment or topic filter excludes articles that are not enriched yet | "{n} articles match your text and date filters but are not enriched yet, so the sentiment/topic filter leaves them out. [Show them without that filter]" |
| Error: parse | Client or server parse error | Message with position under the input (see copy), previous results stay with the note "Showing results for the previous query" |
| Error: service | 5xx, timeout, network | "Search is temporarily unavailable. Your query and filters are unchanged. [Try again]" |
| Error: too slow | Server statement timeout | "That search took too long. Try narrowing the date range or removing a wildcard." |
| Partial enrichment | Some matching articles are not enriched | Cards show their own state (below); `CoverageLine` shows the counts |

The fourth empty state, **enrichment unavailable**, is not an empty result: it applies per card and as a banner.

**Copy for key messages:**

- Parse errors use the server messages in the search spec section 8 with a caret under the position, for example: "Missing closing bracket (position 12)".
- Parsed echo label: "Interpreted as:" followed by the fully bracketed query, e.g. `("oil prices" AND ("geopolitical" OR "supply chain"))`. Implicit AND is shown explicitly, so a missing OR is visible.
- Coverage line: "{n} articles in scope · {a} with sentiment · {b} with topics · data up to {watermark} UTC".
- Banner, budget: "Enrichment is paused: today's {provider} budget is used up. New articles are searchable but show no summary or sentiment until it resumes after 00:00 UTC."
- Banner, provider outage: "Enrichment is delayed: {provider} is not responding. Articles remain searchable. We will retry automatically."
- Banner, disabled by operator: "Enrichment is switched off."

**Keyset pagination:** "Show more" button (no page numbers, no total pages). The count text shows "Showing {k} of {total}" only when the server was asked for the total (opt-in), otherwise "Showing {k}".

### 5.2 Trends (`/trends`)

**Purpose:** answer "how many articles, over time, for this query and these filters?".

**Layout:** shared `QueryInput` and `FilterBar`; then `TrendControls` (Bucket: Week (default) | Month; Split by: None | Sentiment | Language | Topic; View: Chart | Table); then the chart or table; then notes.

**Content rules:**

- A one-line summary above the chart: "{total} articles · weeks start Monday, UTC · {from} to {to}".
- Empty buckets are shown as zero (a visible baseline tick), not skipped.
- Split by sentiment: series are Positive, Negative, Neutral, Mixed and **Not yet enriched** (hatched and last). Totals still equal the unsplit total.
- Split by topic: a persistent note, "An article counts under each of its topics, so the bars can add up to more than the total." (ADR-0008).
- Split by language: one series per language present. Source is deliberately not offered (each sample article has its own source).
- Each bar and each table row is a link: "Week of 29 Jun 2026: 6 articles. Open these articles." to Search with `from` and `to` equal to the bucket's half-open range, the same filters and, when split, that series as the filter.

**States:** first load (skeleton axes); refreshing (previous chart dimmed, same rules as Search); results; empty no-match and not-covered with the same copy as Search; error with retry; range too wide ("That range has too many {weeks}. Choose a shorter range or switch to months.").

### 5.3 Article (`/articles/[id]`)

**Purpose:** explain exactly what is stored and why each label looks as it does (P7, P8).

Sections, in order:

1. **Header:** headline (or the placeholder), source, language, published time (UTC, with the exact timestamp on hover/focus), article id.
2. **Text:** body as plain text with preserved paragraph breaks, rendered inert, direction isolated. Above it, if text was changed: "Markup was removed from this article. [What changed]".
3. **Derived values:** sentiment (label, confidence, why), summary (with "AI-generated, automated" tag), topics each with confidence. Low-trust marker if applicable. Mock-origin tag if applicable.
4. **What was done to this text** (the transformation list from the ledger), e.g. "Headline: 1 `img` element removed (checksum a1b2…)", "Body: 1 `script` element and its content removed", "Whitespace collapsed". Plain language, counts, no raw markup shown.
5. **Processing trail:** ingest event (batch, outcome, flags), each job with state, attempts, timestamps, reason code; enrichments with provider, model (requested and reported), prompt version, origin (provider / cache / mock), tokens, cost, trust. A "same content as" list when `duplicate_content` is flagged.
6. **Developer link:** "View trace (JSON)" to the trace endpoint.

States: loading; not found ("No article with this id"); partial (jobs still running: each part shows its own state); error.

### 5.4 Status (`/status`)

**Purpose:** "is everything accounted for, and is enrichment running?". Auto-refreshes every 10 seconds, pauses while the tab is hidden, shows "Last updated hh:mm:ss UTC".

Content: a headline tile "Complete" / "Processing" / "Complete with gaps" derived from `complete` and `gaps` (telemetry spec section 9); tiles for articles total, reconciled batches (any unreconciled batch highlighted), jobs by state per part, oldest actionable job age, per-provider budget bar (used/reserved/cap) and breaker state, quarantine open and oldest age, watermark. Each tile links to the explanation of the number (the same definitions as the API). States: loading, stale ("Data older than 60 s"), error.

## 6. Component specifications

No front-end exists, so every component is new. Use semantic HTML and plain CSS or a minimal utility layer; no component library is required. Rendering rule for every component that shows article-derived text: React default escaping only; no raw HTML sinks (data-sanity section 7).

| Component | Purpose and variants | Key states and rules | Accessibility |
| --- | --- | --- | --- |
| `TextBlock` | Renders any article-derived string. Wraps text in an element with `dir="auto"`, `unicode-bidi: isolate`, and `lang` set from the article's language only if it matches a BCP 47 pattern | Long text clamps with "Show full text" | Language attribute helps screen-reader voices and CJK fonts |
| `QueryInput` | Single-line input, Search button, example chips | Valid, invalid (with caret and message), searching (button label "Searching…", input stays editable), disabled never | Label "Search query", `aria-describedby` for the echo and error; Enter submits; `/` focuses it |
| `ParsedEcho` | "Interpreted as: …" | Hidden when empty; shows last valid parse when the current text is invalid, labelled as such | `aria-live="polite"` is not used (changes while typing); updated on submit |
| `FilterBar` | Date range, source, language, sentiment, topic | Changes apply after 250 ms; active filters appear as removable chips; "Clear all" | Each control labelled; chips are buttons with "Remove filter: Language: AR" |
| `CoverageLine` | The honest-numbers line | Variants: normal; partial (amber text and icon); stale | Text, not colour alone |
| `Banner` | Enrichment paused / delayed / switched off | Appears from status flags; dismissible per session only for info-level | `role="status"` |
| `ArticleCard` | One result | See below | `<article>` with a heading; list is a `<ul>` |
| `SentimentBadge` | Positive, Negative, Neutral, Mixed, Not yet enriched, Unavailable | Text label always; icon shape differs (plus, minus, circle, plus-minus, clock, dash); confidence figure next to it | Contrast at least 4.5:1; label read as "Sentiment: Negative, confidence 78%, classifier" |
| `TopicChip` | One topic with its confidence | Up to 3 plus `Other`; "no confidence available" when absent | Chip is a link to Search with that topic filter |
| `ConfidenceFigure` | "78%" plus a small "Why?" button | States: value, "no confidence available", "mock" | Button has aria-expanded and controls the popover |
| `WhyPopover` | The "Why this number?" explanation | Fields: origin in words, method and version, raw value and range, normalised value, provider/model/prompt version, produced time, trust, class probabilities for sentiment | Disclosure pattern; Esc closes and returns focus; not hover-only |
| `TrustMarker` | "Possible prompt injection in the source text. Labels are low-trust." | Shown only when `trust = low` | Icon plus text |
| `OriginTag` | "AI summary (automated)", "Mock output" | Always on the summary; mock replaces "AI" | Text |
| `EmptyState` | Four variants (no match, not covered, not yet processed) plus enrichment-unavailable inline | As the copy above | Heading level, focusable container so focus lands on it after a search |
| `ErrorState` | Parse, service, timeout | Retry button keeps inputs | `role="alert"` for service errors |
| `LoadMore` | Next keyset page | Idle, loading (disabled, spinner), done (hidden), error (retry) | Focus moves to the first new card; polite announcement "20 more results loaded" |
| `TrendChart` | Vertical bars, stacked when split | Hover/focus shows values; bars are links; hatched pattern for Not yet enriched | `role="img"` with a generated summary label; the table is the accessible equivalent |
| `TrendTable` | Buckets as rows, series as columns, total column | Always rendered (hidden visually when Chart view, still in the DOM is not required; Table view is one toggle away) | Real `<table>`, headers scoped |
| `SeriesLegend` | Series names with pattern swatches | Multi-label note for topics | Text names, not colour only |
| `StatusTile` | A number, its meaning and a state (ok, warn, bad) | Text states "OK", "Attention", "Problem" | Not colour alone |
| `ProcessingTrail`, `TransformationList` | Article-screen sections | Plain-language rows | Definition lists |

**`ArticleCard` content and states**

Fields in reading order: headline (`TextBlock`, or "(no headline)" in muted italic, with the title attribute "The source did not supply a headline"); metadata line (source, language label such as "AR", published date in UTC with an absolute timestamp on focus); flag chips (only the meaningful ones: "Markup removed", "Possible prompt injection"); summary or its state; sentiment badge with confidence; topic chips with confidences; first 600 characters of body behind "Show more"; link "Details".

Enrichment state shown on the card (from the job ledger):

| State | Summary area | Sentiment / topics |
| --- | --- | --- |
| Enriched | AI summary | Badge and chips |
| Partial (one part done) | Summary or "Summary pending" | The done part shows; the other shows "Pending" |
| Queued / running | "Not yet enriched" | "Pending" |
| Failed, retrying | "Enrichment delayed, retrying" | "Pending" |
| Deferred, budget | "Enrichment paused: daily budget reached" | "Paused" |
| Dead | "Enrichment unavailable" with the reason in plain words on focus | "Unavailable" |
| Skipped, no content | "No text to analyse" | "Not applicable" |
| Low trust | Summary shown with the `TrustMarker` | Confidence figures shown with a warning icon |
| Mock origin | `OriginTag` reads "Mock output" | Badge carries "mock" |

## 7. Key flows

**F1: search, refine, trend, drill through (primary).** Open Search; click an example chip or type `"oil prices" AND (geopolitical OR "supply chain")`; the parsed echo appears; Enter; one card (id 1) with sentiment and topics; add Language = EN; click "View trends for this search"; the chart shows a single bar for the week of 8 Jul; click the bar; Search opens with `from=2026-07-13 to=2026-07-20` and the same query; the count equals the bar's number; a chip "Date: 13 Jul to 20 Jul (from trends)" can be removed.

**F2: fix a query.** Type `AI AND`; the caret and message "AND needs a term on both sides (position 6)" appear instantly; previous results stay, labelled "Showing results for the previous query"; typing a term clears the error; Enter runs the search.

**F3: judge a label.** On a card, click the confidence figure; the popover explains origin and range ("Classifier confidence measures how decisive the choice was. It is not the chance the label is right."); "Open article" shows the same fields plus the provider and prompt version.

**F4: inspect the injection samples.** Open the article with the script in its body: the text appears as readable sentences; "Markup was removed from this article. What changed" lists the removed elements by count and checksum; nothing executes.

**F5: enrichment paused.** The banner appears on every screen; cards show "Enrichment paused"; Status shows the provider's budget bar full and jobs "deferred"; the next day the state clears by itself.

**F6: check completeness.** Status headline reads "Complete" when all admitted articles are fully processed, "Complete with gaps" when some are dead or quarantined (with counts and links), or "Processing" while jobs are open.

## 8. Principle compliance

| Principle | How the interface meets it | Where |
| --- | --- | --- |
| P1 Fast | Unenriched articles are searchable and shown immediately; perceived-speed rules in section 11 | Search, cards |
| P3 Complete, honest | Three empty states; coverage line; "Not yet enriched" series so totals conserve; partial states; banners | Search, Trends, Status |
| P4 Signal over volume | Summary first, body behind "Show more"; duplicates listed on the Article screen | Cards, Article |
| P5 Languages | `dir="auto"`, isolation, `lang`, CJK line breaking, language labels, search works with Arabic and Chinese terms | `TextBlock`, query box |
| P6 Confidence | Figure beside every derived value; "no confidence available" when absent | Cards, Article |
| P7 Inspectable | "Why this number?" with origin, method, version, raw value and range; plain statement that jev confidence is decisiveness and LLM confidence is self-reported | `WhyPopover` |
| P8 Traceable | Article screen: transformations, trail, provenance, trace JSON | Article |
| P9 Human judgment | Every derived value is labelled automated; mock labelled; no review or override control in this build (schema allows origin `human`) | Cards. Documented gap |
| P10 Meaning | Sentiment and topic splits over time; drill-through to evidence | Trends |
| P11 Audience | Dense, keyboard-first layout for analysts; examples for new users | Search |

## 9. Data requirements

| Data the UI needs | Provided by | Gap |
| --- | --- | --- |
| Article fields, flags, `body_excerpt`, `ingested_at` | List API (search and DBA specs) | None |
| Current derived values with confidence, origin, method, range, trust, provider, model, prompt version, class probabilities | `derived_values`, `enrichments` (DBA 4.2), batch hydrated per page | None |
| Job state per article and part | `enrichment_jobs` (DBA 4.2) | None |
| `coverage`: articles in scope, enriched counts, excluded by derived filter, watermark | Search spec section 8 | **G1:** the empty states need `articles_matching_base_filters`, the count after date, source and language filters but before text and derived filters. Added to the search spec |
| Facet values for filters: sources, languages, topics, sentiments with counts | None specified | **G2:** add `GET /api/facets` (distinct values and counts for the unfiltered corpus; cached). For many sources, type-ahead search instead of a full list |
| Parser for client-side validation | Pure parser module (search spec HP-S1) | Must be importable on the client; no server-only imports |
| Transformations per article | `ingest_transformations` (DBA 4.4) | None |
| Duplicate-content links | `content_hash` index (DBA 4.1) | Add to the article detail response |
| Status numbers | `/api/status` (telemetry section 9) | None |
| "Late" marker (missed 15 minutes) | `ingested_at - published_at` for live batches | **G3:** not shown in this build (all sample loads are backfill). Specified for the growth path: a "Late" chip when live capture lag plus processing exceeds 15 minutes |
| Human review or override | None | **G4:** not built; documented as the growth path |

## 10. Accessibility and internationalisation

- **Keyboard:** skip link; logical tab order (header, query, filters, results, load more); `/` focuses the query; Enter submits; Esc closes popovers; focus returns to the trigger; after "Show more" focus moves to the first new card; after a search that returns an empty state, focus moves to that state's heading.
- **Screen readers:** results count and state changes announced through one polite live region; errors through `role="alert"`; badges read as full phrases; chart has a text summary and the table alternative; bars have descriptive names.
- **Colour:** no meaning by colour alone (text labels, icon shapes and hatching); contrast at least 4.5:1 for text and 3:1 for chart elements; works in forced-colours mode.
- **Motion:** no animation beyond the 150 ms delayed progress bar; respects `prefers-reduced-motion`.
- **Zoom and size:** usable at 200% zoom and at 320 px width.
- **UI language:** English only in this build. All UI strings are in one dictionary so that they can be translated; no string concatenation of sentences.
- **Content language:** each article string is isolated and given its own direction and `lang`. Arabic text aligns to the right inside its block even though the page is left to right; the query box accepts Arabic and Chinese and sets `dir="auto"`; parsed-echo terms are isolated so operators (`AND`, `OR`) stay readable in a right-to-left query. Chinese lines break between characters, never hyphenate; font stacks include system CJK and Arabic fonts. Numerals are shown as supplied. Dates are always UTC and labelled.
- **Responsive:** under 640 px the filter bar collapses to a "Filters ({n})" disclosure; cards are single column; the trend table scrolls horizontally inside its own container; status tiles stack.
- **Live updates at 800/s:** none in this build. Results do not change under the user's cursor; a growth-path rule: show "N new articles since {time}. [Refresh]" driven by a watermark poll rather than live insertion.

## 11. Wireframe brief

**Fidelity:** low, grayscale, real copy from this spec, real sample content (including the Arabic, Chinese, empty-headline and sanitised articles). No visual polish.

**Wireframe first:**

1. Search with results (three cards: id 1 enriched with positive/negative confidence, id 8 Arabic, id 6 sanitised with "Markup removed" and a low-trust marker mock-up).
2. Search with a parse error and previous results retained.
3. The three empty states side by side.
4. A card with each enrichment state from the table in section 6.
5. The "Why this number?" popover for jev sentiment and for an LLM topic.
6. Trends in Chart view and Table view, unsplit and split by sentiment (with the hatched series) and by topic (with the multi-label note).
7. Article screen with the transformation list and processing trail.
8. Status with each of the three headline states.

**Layout hierarchy (Search), text sketch:**

```
[Media Signal]  Search  Trends  Status
[ banner: Enrichment is paused ... ]
[ query box.......................................................][Search]
  examples: [oil prices...] [renewable AND NOT ...] [AI AND ...]
  Interpreted as: ("oil prices" AND ("geopolitical" OR "supply chain"))
[Date range][Source v][Language v][Sentiment v][Topic v]   chips: [Language: EN x]
20 articles in scope · 18 with sentiment · 18 with topics · data up to 14 Jul 2026 08:30 UTC
Showing 1                                         View trends for this search
+----------------------------------------------------------------------+
| Global Oil Prices Surge Amid Middle East Tensions                    |
| Reuters · EN · 14 Jul 2026 08:30 UTC                                 |
| AI summary (automated): Crude oil rose 3.2% ...                      |
| [- Negative 81% (Why?)]  [Energy 76%] [Geopolitics 70%]               |
| Show more · Details                                                   |
+----------------------------------------------------------------------+
[ Show more results ]
```

**Questions for the wireframes to answer:** does the confidence figure stay legible without dominating the card? Is the parsed echo noticed? Can a user tell the three empty states apart at a glance? Does the Not-yet-enriched series read as "missing", not as "zero"?

## 12. Smoothing items that matter (perceived responsiveness)

These are functional requirements of the first build, because they decide whether the correct behaviour feels broken:

| Item | Rule |
| --- | --- |
| Debounce | Filters 250 ms; client parse validation 300 ms; the query itself runs only on submit |
| Stale responses | Every request carries a client sequence number and an `AbortController`; a response that is not the latest is ignored; changing inputs aborts the previous request |
| In-flight display | Previous results stay (dimmed, `aria-busy`); the progress indicator appears only after 150 ms and stays at least 300 ms to avoid flicker; skeletons only on the very first load |
| Submit button | Label "Searching…", disabled only while an identical request is in flight; re-submitting a changed query aborts the old one |
| Double submit | `LoadMore` is disabled while fetching and uses the cursor, so a double click cannot add a page twice |
| Error recovery | Inputs and filters never reset on error; "Try again" re-runs the same request |
| No layout shift | Badge and chip areas reserve their height; skeleton cards match card height |
| Client timeout | Abort at 10 seconds with the "taking longer than expected" message |
| Status polling | 10 s interval, paused when the tab is hidden, last-updated time shown |
| Back/forward | URL is the state; restoring a URL restores the screen |

A separate polish pass after the functional build (the ux-smoothing approach) can refine these; the list above is the minimum.

## 13. Implemented versus optional

| Item | Status |
| --- | --- |
| Search, Trends, Article, Status screens; the four empty/error classes; confidence and "Why this number?"; direction isolation; table alternative; section 12 rules | **Implement** |
| `GET /api/facets` and G1 (`articles_matching_base_filters`) | **Implement** (small) |
| Client-side parse validation | **Implement** (shared pure module) |
| Matched-term highlighting | Optional (client-side on escaped text) |
| "Hide confidence figures" collapse control | Optional (the figure may collapse to an icon but never disappear) |
| "Late" marker, new-articles banner, human review controls | Documented growth path |
| Translation of the UI | Documented; strings centralised |

## 14. Decisions needed and open questions

| ID | Decision | Options (recommended first) |
| --- | --- | --- |
| UX1 | Chart implementation | (a) Small custom SVG bar component plus the table (no dependency, full control of patterns, labels and accessibility, safest for XSS review); (b) a charting library (faster to a polished look, heavier, harder to meet the pattern/labelling rules) |

Held defaults: shared URL filter state; run-on-submit for the query; week default; confidence shown by default with a "Why?" popover; optional highlight not built; the Status link is in the main navigation.

Open questions: do the graders expect a particular chart type (bars assumed)? Should the UI offer an export (the Carma context defers exports)? `UNCONFIRMED`: no.

Gaps G1 and G2 have been added to the search spec (section 8) so the plan carries them.
