---
spec: carma-ux
number: 0004
title: English-first cards and article page, query echo for default and exact matching
status: draft
date: 2026-10-24
feature: english-first-substring-search
inputs: [.specs/architect/0004-english-first-substring-search.md, .specs/search/0003-english-first-substring-search.md, .specs/telemetry/0004-english-first-substring-search.md, .specs/ux/0003-article-translation.md]
principles: [P3, P5, P7, P8, P11]
supersedes: null
---

# 0004 English-first cards and article page, query echo for default and exact matching

## 1. Summary
Changes to three existing surfaces, no new page: the search result card (`src/components/ArticleCard.tsx`), the article page text block (`src/components/TranslatedText.tsx`) and the query echo on the search page (`src/components/search/SearchPage.tsx`). Rule for all of them: **English first, original always one step away, state of the translation always visible**. English-original articles look as they do today. Supersedes UX 0003 where it says cards lead with the original (ADR-0026) and where the article page toggle swaps (ADR-0032).

## 2. Users and core intents
Unchanged from UX 0003. Primary: an analyst scanning results in English to judge relevance, then checking the original wording when it matters. Secondary: verifying a translation against its source (P8).

## 3. Approaches considered
- **Reveal underneath (chosen by the user, ADR-0032)** versus swap: reveal keeps the English visible while the original is read, so the two can be compared line against line. Cost: longer page when open.
- **Native `<details>` for the reveal (recommended)** versus a JavaScript toggle button: `<details>` works without JavaScript (closes the no-JS gap, FP-9), is keyboard operable and announced by screen readers, and needs no state. Cost: less control over the open/close animation (none wanted) and the usage beacon has to listen to the `toggle` event. Default, UNCONFIRMED; the button form also satisfies this spec if the designer prefers it.

## 4. Information architecture
No new pages. Flow: search results (English headline, English excerpt) → "Show original" on the card, or "Details" → article page (English text, original underneath on request).

## 5. Page specifications

### 5.1 Search card, foreign-language article
Order top to bottom:
1. **Primary headline** (`h2`): English headline, `lang="en"`.
2. **Original headline**, one line under it: muted, label "Original (Arabic):" followed by the original text with `dir="auto"` and its own `lang`. Wraps on narrow screens, never truncated to hide script.
3. Meta line: source · language code · date (unchanged), plus "Machine translated" as a muted tag next to the language code (P7). The `matched in translation / both` marker stays here (unchanged component).
4. Flags, AI summary, sentiment, topics: unchanged.
5. **Text area:** the existing "Show more" control reveals the **English excerpt** (`body_excerpt_en`, `lang="en"`, first 600 characters). Under the English excerpt, a second control **"Show original text"** reveals the original excerpt underneath it, labelled "Original text (Arabic)". Both are `aria-expanded` controls; the second is only offered once the first is open.
6. "Details" link unchanged.

### 5.2 Search card, states
| State (foreign article) | Primary headline | Under it | Text area |
| --- | --- | --- | --- |
| Translated, headline and body | English headline | Original headline | English excerpt, then original on request |
| Translated, headline missing in translation | Original headline | Note "Headline not translated" (existing string) | English excerpt, then original on request |
| Translated, body missing | English headline | Original headline | Original excerpt only, note "Body not translated" |
| Translation queued, running or failed (retryable) | Original headline | Note "English translation pending" | Original excerpt |
| Paused (budget) | Original headline | Note "English translation paused: daily budget reached" | Original excerpt |
| Dead (failed) | Original headline | Note "English translation unavailable", reason on the article page | Original excerpt |
| No text to translate | Original headline | Note "No text to translate" | none |
| Older article, never scheduled (ADR-0028) | Original headline | Note "Not translated (older article)" | Original excerpt |
| English article | Headline | nothing | Excerpt, unchanged |
| No headline from source | "No headline" placeholder (existing) | English headline if one exists | as above |
The pending, paused and unavailable notes are plain muted text, not `role="status"`, because there can be many per page; the page-level coverage line (`UntranslatedNote`) stays the one live-region summary. State is derived from the translation job state already returned per row (`jobs`), through the same mapping as the article page (`src/lib/translate/display.ts`).

### 5.3 Article page `/articles/[id]`
1. Translation label row (unchanged): "Machine translated from Arabic", mock and low-trust notices, "Automated translation" disclosure.
2. **Headline block:** `h1` English headline; under it, muted, the original headline labelled "Original (Arabic)". Both always visible (not part of the reveal). Same missing-headline fallbacks as the card.
3. **Body:** the English text.
4. **Reveal control** under the English text: "Show original text (Arabic)" → opens a region underneath titled "Original text (Arabic)", while the English stays visible above. Label when open: "Hide original text".
5. Pending, paused, unavailable and no-text states keep the existing `TranslationNotice` and show the original body as the only body, with no reveal control.

Removed: the swap button and the fixed minimum-height trick (stacked content does not jump).

### 5.4 Query echo and hint (search page)
*Revised 2026-10-28 (ADR-0036): bare words are exact again, so the loose-match note, the quote tip and the trigram notice are removed.*
- Echo line unchanged in position and format: phrases in straight double quotes, wildcards as `renew*`, other terms bare: `Interpreted as: ("media intelligence" AND renew*)`.
- Input help text (under or inside the search box): "Tip: add * to a word to match longer and related forms, for example renew*. Use quotes for an exact phrase."
- Existing notes stay: non-Latin terms note; NOT note worded "NOT terms exclude articles by their original text only."
- A wildcard term gets no extra note; the echo already shows it.
- Zero results: the three empty states are unchanged; when the query has bare Latin terms and no wildcard, the no-match state adds "No exact matches. Try adding * to a word, for example startup*."

### 5.5 Amendment A (ADR-0035): match marker covers summaries
`matched_in` becomes a set of sides (`original`, `translation`, `summary`). The marker (`MatchedInTag`) shows whenever a side other than the original matched: "Matched in translation", "Matched in summary", "Matched in translation and summary", or with the original: "Matched in original and summary". A match in the original alone shows no marker (as today). The marker's tooltip for the summary: "The search term was found in the automated summary of this article." The summary on the card is already visible; when the summary matched, no extra control is needed. Copy keys added: `matchedInSummary`, `matchedInTranslationAndSummary`, `matchedInOriginalAndSummary`, `matchedInSummaryTooltip`.
Coverage line: add "N articles in this selection have no summary yet, so English terms in summaries may miss them." (only when N > 0; data from the enrichment ledger, already counted for the status page). UNCONFIRMED wording.

## 6. Component specifications
| Component | Change | Reuse or new |
| --- | --- | --- |
| `ArticleCard` | Headline pair, state note, two-level reveal | Edit |
| Headline pair selection | One pure function returning `{primary, primaryLang, secondary, secondaryLang, note}` for a row; shared by card, article page and `<title>` | New (small, unit-tested; architect FP-7) |
| `TranslatedText` | Stacked reveal replacing swap; `<details>` | Edit |
| `MatchedInTag`, `TranslationNotice`, `UntranslatedNote`, `TextBlock` | Unchanged | Reuse |
| Query echo | Already prints phrases in quotes; add the unquoted-term note | Edit (`src/lib/search/echo.ts` and `SearchPage.tsx`) |

## 7. Key flows
1. Search "startups" → card shows English headline "…startup…" with the Arabic or French original under it → analyst opens "Show more" for the English excerpt → opens "Show original text" to check the wording → follows "Details" for the full text.
2. Analyst wants precision → wraps the word in quotes → echo shows `"startup"` → only whole-word hits remain.
3. Foreign article not yet translated → card shows original with "English translation pending" → coverage line explains the batch.

## 8. Principle compliance
| Principle | How | Where |
| --- | --- | --- |
| P3 | Pending, paused, unavailable and older-article states named on the card; zero-result states unchanged | 5.2, 5.4 |
| P5 | `lang` and `dir="auto"` on every text block; original script never truncated | 5.1, 10 |
| P7 | "Machine translated" tag on cards; echo shows what was matched exactly | 5.1, 5.4 |
| P8 | Original headline always shown; original text one control away; Details to the full trail | 5.1 to 5.3 |
| P6 | No confidence is shown for translations (ADR-0024 stands); existing derived values unchanged | n/a |
| P11 | Scan in English first | 5.1 |

## 9. Data requirements
| Field | Source | Status |
| --- | --- | --- |
| `headline_en` | search API (`src/lib/search/run.ts`) | exists |
| `body_excerpt_en` | search API, `left(tr.body_en, 600)` | **new** (DBA 0004 section 9) |
| `body_excerpt` (original) | search API | exists |
| translation job state per row | `jobs` in the search response | exists |
| `matched_in` | search API | exists |
| `language` | search API | exists |
| language display name | `languageDisplayName()` (`src/lib/translate/display.ts`) | exists |
| index health flag `trgm_index` | status | exists; needs exposing to the search page (gap, small) |
| Unquoted-Latin-term flag for the echo note | parse result | derivable client-side from the AST |

## 10. Accessibility and internationalisation
- Reveal controls: native `<details>`/`<summary>` or a button with `aria-expanded` and `aria-controls`; focus stays on the control after toggle; polite live announcement "Original text shown below" / "Original text hidden". Minimum touch target 44 px (existing pattern).
- Revealed region has an accessible name "Original text (Arabic)".
- No JavaScript: article page works fully (`<details>`); card reveals need JavaScript today (client component) and the original excerpt can be placed in a `<noscript>` or `<details>` as on the article page. Details link is always available.
- Direction: English blocks left-to-right; original blocks `dir="auto"` with `unicode-bidi: isolate` (existing `TextBlock`), text aligned to start; the labels around them stay in the UI's direction. Chinese: no word-based truncation; wrap normally; correct font fallback by `lang`.
- Not colour alone: pending and unavailable states use text.
- Reduced motion: no animation specified.
- Strings below go through `src/lib/ui/strings.ts`.

Copy (new or changed):
| Key | Text |
| --- | --- |
| `originalHeadlineLabel(lang)` | "Original (Arabic):" |
| `translatedTag` | "Machine translated" |
| `showOriginalText(lang)` | "Show original text (Arabic)" |
| `hideOriginalText` | "Hide original text" |
| `originalTextHeading(lang)` | "Original text (Arabic)" |
| `liveOriginalShownBelow` | "Original text shown below" |
| `liveOriginalHidden` | "Original text hidden" |
| `cardPending` | "English translation pending" |
| `cardPaused` | "English translation paused: daily budget reached" |
| `cardUnavailable` | "English translation unavailable" |
| `cardOlderNotTranslated` | "Not translated (older article)" |
| `bodyNotTranslated` | "Body not translated" |
| `wildcardTip` | "Tip: add * to a word to match longer and related forms, for example renew*. Use quotes for an exact phrase." |
| `noExactMatchHint` | "No exact matches. Try adding * to a word, for example startup*." |
| `notOriginalOnlyNote` | unchanged: "NOT terms exclude articles by their original text only." |
(Removed in the 2026-10-28 revision: `echoLooseNote`, `quoteTip`, `trgmOffNote`.)
Retired: `englishHeadline` ("English: ..."), `showOriginal`/`showTranslation` swap labels, `liveTranslation`.

## 11. Wireframe brief
Wireframe first: (1) one search card in each state row of 5.2 for a left-to-right original (French) and a right-to-left original (Arabic); (2) the article page with the reveal closed and open at desktop and phone width; (3) the search box with echo, loose-match note and tip. Questions the wireframe should answer: does the second headline line add noise when the page shows 20 foreign cards; where does the "Machine translated" tag sit so it is seen but does not outrank the headline. Low fidelity, structure and content only.

## 12. Decisions needed and open questions
- None blocking. Default taken: native `<details>` for the reveal (UNCONFIRMED, section 3).
- Open: whether the AI summary on a foreign card is in English (it should be, its `lang` attribute is set from the article language today); confirm and fix in the plan if wrong.
- Open: whether the "Machine translated" tag on cards is wanted on every translated card or only on hover; default every card.
