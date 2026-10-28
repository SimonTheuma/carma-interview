---
spec: carma-ux
number: 0003
title: Translated article view with reveal-original, and search markers
status: draft
date: 2026-10-24
feature: article-translation
inputs: [.specs/architect/0003-article-translation.md, .specs/architect/adrs/0024-translation-no-confidence-article-page-only.md, .specs/architect/adrs/0025-search-covers-original-and-translated-text.md, .specs/search/0002-article-translation.md, .specs/data/sanitization/0003-article-translation.md, .specs/data/dba/0003-article-translation.md, .specs/telemetry/0003-article-translation.md, .specs/ux/0002-json-file-upload.md]
principles: [P1, P3, P5, P6, P7, P8, P9]
supersedes: null
---

# 0003 Translated article view with reveal-original, and search markers

## 1. Summary
For a non-English article, the article page shows the English translation of headline and body by default, labelled as machine translation, with one toggle to show the original and back. The original is always one click away and never removed (P8). Every state where a translation is not available says so in words and shows the original instead (P3). Search results gain a "matched in translation" marker and a standing note about foreign articles not translated yet. No confidence is shown for translations; the interface says "no confidence available" in the explanation (ADR-0024, P6, P7).

## 2. Users and core intents
| Role | Intent | Rank |
| --- | --- | --- |
| Analyst | Read what a foreign article says without leaving the page, and judge whether the translation can be trusted | Primary |
| Analyst | Check the original wording (a quote, a brand name, a figure) | Primary |
| Analyst | Find a foreign article by an English term or an original-language term | Secondary (search) |
| Operator / developer | See why an article has no translation (pending, paused, failed) | Secondary |
The primary intent is reading, so the layout puts the translated text first and the check-the-original action next to it.

## 3. Approaches considered
| Option | For | Against |
| --- | --- | --- |
| A. Toggle that swaps one text block (recommended, as requested) | One column, no layout jump if sized sensibly, clear default, simple on mobile | Cannot compare line by line |
| B. Side by side | Easy comparison | Needs width, poor on mobile, doubles reading effort, no toggle as asked |
| C. Inline paragraph reveal | Fine-grained check | Complex, hides context, harder for RTL |
Recommendation: A. A "side by side" view is a possible later addition and is not designed here.

## 4. Information architecture
No new pages. Changed: `/articles/[id]` (`src/app/articles/[id]/page.tsx`), search results cards (`src/components/ArticleCard.tsx`, used by `src/components/search/SearchPage.tsx`), and the search page coverage area (`src/components/CoverageLine.tsx` neighbourhood). The trace JSON (`/api/articles/:id/trace`) gains the translation row (no UI change).

## 5. Page specification: article page `/articles/[id]`
Purpose: read and verify one article. Primary intent: read the translation, with a quick path to the original.

Layout, top to bottom (existing sections after "Text" are unchanged):
1. **Header.** Headline, then the metadata line (source, language, published, id, version). The headline follows the view: translated headline in translated view, original headline in original view. Metadata line gains the language as a readable name ("Arabic (ar)") instead of only the code.
2. **Translation bar** (new, directly under the header, above the text; only for articles that need translation):
   - Left: label "Machine translated from Arabic" (language name from the stored code; if unknown, "Machine translated"). When showing the original, the label reads "Original text (Arabic)".
   - Right: the toggle button, text "Show original" in translated view and "Show translation" in original view. Same position in both views.
   - Secondary line (muted): "Automated translation, not reviewed by a person. No confidence score is available." with a small "About this" disclosure explaining: model name and prompt version, when it was produced, trust flag if any, that the original is the system of record. This is the P7 "why" and reads from the `enrichments` row.
3. **Text.** One text region for the active view. Both texts are in the page HTML; the inactive one is hidden, so switching needs no request.
4. Existing sections: version list, derived values, transformations, processing trail. The processing trail gains a line "Job translation: succeeded · attempts 1" like the other jobs, and the enrichment line shows provider/model/origin/trust.

### Toggle behaviour
- One `<button type="button">`, with `aria-pressed` true while the original is shown, and `aria-controls` pointing at the text region. Visible label changes with the state; the accessible name stays "Show original text" / "Show translation" so screen readers hear the action.
- Keyboard: reachable in the tab order immediately after the page heading, activates with Enter and Space. Focus stays on the button after activation. After a switch, a polite live region announces "Showing original text (Arabic)" or "Showing English translation".
- Default is the translation whenever a valid current translation exists. Not remembered between articles or visits in the first version (the original is a deliberate check, not a preference). Optional later: remember per browser session. UNCONFIRMED.
- No layout jump: the text region keeps its minimum height from the taller of the two blocks (render both, hide one with a visually-hidden-but-measurable approach or set `min-height` from the longer one); the translation bar does not move. Scroll position is kept. On an article longer than one screen the toggle may scroll out of view, so it also appears as a compact sticky button at the top edge of the text region on scroll (UNCONFIRMED; default: show the bar again at the end of the text with the same button).
- Direction and language per block (P5): translated block `lang="en"`, `dir="ltr"`; original block `lang` = stored language, `dir="auto"` with bidi isolation (existing `TextBlock`). Headline and body each carry their own attributes. The metadata line and the toggle stay in the page's own direction. For an RTL original, the original block is right-aligned inside the same column; the toggle does not move.
- Fonts: the existing stack covers Arabic and CJK (`--font-sans` in `globals.css`); CJK text uses no word-spacing assumptions and wraps by character.
- Text is rendered as text only. No Markdown, no links, no HTML from the model output (data-sanity 0003 section 7). Paragraphs preserved with `whitespace-pre-wrap`.
- A small client component, `TranslatedText` (below), owns the toggle; the page stays a server component and passes both texts as props. Check `node_modules/next/dist/docs/` for client component rules before coding, per `AGENTS.md`.
- The toggle click sends the usage beacon (`view` only) per telemetry 0003 section 8; failure of the beacon is silent.

### Headline treatment
Both headlines come from the same row: `headline_en` and `articles.headline`. If the original has no headline, show the existing "(no headline)" placeholder in both views. If the translation has no headline but the original has one (translation row without `headline_en`), show the original headline with a muted note "Headline not translated". The `<title>` of the page uses the headline of the default view.

### States (page)
| State | What the reader sees | Notes |
| --- | --- | --- |
| Translated (default) | Section 5 layout | counter `page_state=translated` |
| Translated, low trust | Same, plus a warning line in the bar: "This text contained instruction-like content, so the translation may be unreliable." Warn colour, icon and text, not colour alone | `trust = 'low'`, ADR-0012 pattern, matches the existing "Possible prompt injection" badge |
| Pending | Original shown. Bar label: "Translation in progress. Showing the original." No toggle button (nothing to switch to). Muted "Check back shortly." | job queued/running/failed_retryable |
| Paused (budget) | Original shown. "Translation paused: the daily translation budget is used up. It will continue automatically." | job `deferred_budget`; reuses wording of the card's "Enrichment paused: daily budget reached" |
| Failed | Original shown. "Translation unavailable." plus a reason in plain words: "The text was too long to translate" (`too_long`), "The translation did not pass quality checks" (invalid output), "The translation service rejected the request" (permanent). Link "Details" to the processing trail anchor | job `dead` |
| No content | Nothing to translate: "No text to translate." | `skipped_no_content` |
| Not needed | English article: no translation bar, no toggle, unchanged page | language `en`/`en-*` |
| Unknown language | Treated as needs translation. If the model reports English, the bar says "This article looks like English; no translation needed." and shows the original | `lang_unknown` flag |
| Loading / error loading translation | The page is server rendered; a database failure for the translation query shows the original and "Translation could not be loaded." (never a blank) | |
Rule: the page never shows the original text labelled as a translation, and never shows a half-translated text (data-sanity: partial translations are not stored).

## 6. Page specification: search results
Primary intent: find articles, then decide which to open. The change is small.

1. **Match marker on each card** when the match came from the translation: a small tag "Matched in translation" next to the language tag; "Matched in original and translation" for both; no tag for original-only (the default). It is text with an info icon, not colour only. Its tooltip/disclosure: "The search term was found in the machine translation of this article."
2. **Card headline stays in the original language.** Every foreign card that has a current translation also shows a one-line muted "English: <translated headline>" below the original headline (ADR-0026; uses `headline_en`, rendered as text, `lang="en"`). If the translation has no headline, or none exists yet, the line is omitted. This line is the only translated text on the list.
3. **Standing note on the search results page** (near the existing `CoverageLine`): "Search matches the original text and, where available, the English translation. N foreign-language articles in this selection are not translated yet, so English terms may miss them." Shown only when N > 0; N and the reason split appear in a disclosure ("N waiting, M paused, K failed"). The sentence is warn-styled when N is more than 5% of the selection, muted otherwise, like the existing partial-enrichment style.
4. **Empty state split** (P3): the existing "no match" message gains the same sentence when N > 0 ("No results. N foreign-language articles in this selection are not translated yet.").
5. **Search echo** (existing `echo.ts`): shows how the query was interpreted. A line is added when the query contains a non-Latin term: "Non-Latin terms are matched as text fragments in the original and in the translation."
6. `NOT` semantics shown in the echo when a NOT term is present: "NOT terms exclude articles by their original text only." (ADR-0027).

## 7. Component specifications
| Component | Status | Purpose | Inputs | States and notes |
| --- | --- | --- | --- | --- |
| `TranslatedText` (client) | New | Holds the toggle, label bar and both text blocks | `sourceLang`, `original: {headline, body}`, `translation: {headline_en, body_en}`, `trust`, `modelInfo`, `producedAt` | `view: "translated" or "original"`; renders both blocks, hides one; live region; beacon on change |
| `TranslationNotice` (server) | New | Bar for non-translated states (pending, paused, failed, no content, not needed message) | `state`, `reason` | text only, with the explanation copy in section 9 |
| `MatchedInTag` | New, small | Search card marker | `side` (translation, both) | tooltip text; not colour-only |
| `UntranslatedNote` | New | Standing search note | `counts {queued, paused, failed}` | warn vs muted; disclosure |
| `TextBlock` | Reuse | Renders each text with `lang`, `dir="auto"`, bidi isolation | existing | unchanged; validates the BCP47 tag |
| `ArticleCard` | Reuse + small change | Adds the tag and English headline line | `matched_in`, `headline_en` | the card is a client component already |
| `CoverageLine` | Reuse | Unchanged; the new note sits next to it | | |
| `strings` (`src/lib/ui/strings`) | Reuse | Add the copy keys in section 9 | | keep copy out of components |

## 8. Key flows
1. **Read a foreign article.** Search or list, open article, read the English text, notice the "Machine translated from Arabic" label, click "Show original" to check a quote, click "Show translation" to return.
2. **Find by English term.** Type "interest rate", results include an Arabic article tagged "Matched in translation" with its English headline line, open it, default is the translation, the matching words are visible.
3. **Find by original term.** Type an Arabic brand name, results match on the original (no tag), open, switch to the original to see it in context.
4. **Why is there no translation?** Open an article that shows "Translation paused", read the reason, follow "Details" to the processing trail to see the job state.
5. **Search note.** Run a search, see "12 foreign-language articles are not translated yet", open the disclosure to see how many are waiting versus paused versus failed.

## 9. Copy (English UI strings)
| Key | Text |
| --- | --- |
| translationLabel | Machine translated from {language} |
| translationLabelUnknown | Machine translated |
| originalLabel | Original text ({language}) |
| showOriginal | Show original |
| showTranslation | Show translation |
| liveOriginal | Showing original text ({language}) |
| liveTranslation | Showing English translation |
| translationDisclaimer | Automated translation, not reviewed by a person. No confidence score is available. |
| translationAbout | Translated by {model} on {date} (prompt {version}). The original text is the record; this translation is derived from it. |
| translationLowTrust | This text contained instruction-like content, so the translation may be unreliable. |
| translationPending | Translation in progress. Showing the original. |
| translationPaused | Translation paused: the daily translation budget is used up. It will continue automatically. Showing the original. |
| translationFailedTooLong | Translation unavailable: the text was too long to translate. Showing the original. |
| translationFailedChecks | Translation unavailable: it did not pass quality checks. Showing the original. |
| translationFailedRejected | Translation unavailable: the translation service rejected the request. Showing the original. |
| translationNoText | No text to translate. |
| translationLooksEnglish | This article looks like English; no translation needed. |
| translationLoadError | Translation could not be loaded. Showing the original. |
| headlineNotTranslated | Headline not translated |
| matchedInTranslation | Matched in translation |
| matchedInBoth | Matched in original and translation |
| matchedInTooltip | The search term was found in the machine translation of this article. |
| untranslatedNote | Search matches the original text and, where available, the English translation. {n} foreign-language articles in this selection are not translated yet, so English terms may miss them. |
| nonLatinTermNote | Non-Latin terms are matched as text fragments in the original and in the translation. |
| notOriginalOnlyNote | NOT terms exclude articles by their original text only. |

## 10. Principle compliance
| Principle | How met | Where |
| --- | --- | --- |
| P3 | Original always one click away; every missing translation says why; search note counts untranslated foreign articles; the empty state is split | Sections 5, 6 |
| P5 | Per-block `lang`/`dir`, RTL original in the same column, CJK wrapping, fonts | Section 5 |
| P6 | "No confidence score is available" stated, never a blank or a made-up figure | Bar, copy |
| P7 | "About this" shows model, prompt version, date, trust flag; the explanation says what the text is | Bar |
| P8 | Original kept and shown; trace JSON and processing trail link translation to the enrichment row; version-bound | Page, trace |
| P9 | Marked "automated, not reviewed by a person"; no edit path yet (out of scope) | Bar |
| P1 | Page and search work with the original before the translation exists | States |
| P11 | One click, same place, no remembered state surprises | Toggle |

## 11. Data requirements
| Field | Used for | Source spec | Gap |
| --- | --- | --- | --- |
| `articles.headline/body/language` | original text | existing | none |
| `article_translations.headline_en/body_en/article_version/superseded_at` | translated text, version guard | DBA 0003 | none |
| `enrichments` row for part `translation`: provider, model, prompt_version, trust, created_at | About this, low-trust warning | DBA 0003 | none |
| `enrichment_jobs` row for part `translation`: state, reason_code | state selection | existing + DBA 0003 | reason codes (`too_long`, `invalid_output`, `permanent`) must be stored in `reason_code`; sanitization 0003 lists them |
| `matched_in` and `headline_en` per search result | card marker and English line | search 0002 | search route must return both |
| Untranslated counts {queued, paused, failed} for the selection | standing note | search 0002 section 10 | new aggregate query, not yet specified in SQL (plan task) |
| Language display name from code | label | none | need a small code-to-name map (`Intl.DisplayNames` in the browser/server, falls back to the code) |

## 12. Accessibility and internationalisation
- Toggle is a real button with a visible focus ring, 44 px minimum touch target on mobile, `aria-pressed`, live region announcement; text is not colour-only for any state or warning.
- Contrast follows the existing tokens; the warn colour pairs with an icon and text.
- Reduced motion: no animation on the swap (an instant switch, no fade).
- Screen readers: each text block has a visible heading or `aria-label` ("English translation", "Original text, Arabic") and its `lang` attribute so the correct voice is used.
- Mobile (360 px wide): the bar stacks: label on the first line, button below at full width; the metadata line wraps; text is one column with the existing 16 px gutter; the sticky mini button is optional. Long Arabic and CJK lines wrap without horizontal scroll.
- Print and copy: copying text copies the visible view only.
- UI strings are English now, kept in `strings` for later translation of the interface itself (P5).

## 13. Wireframe brief
Wireframe at low fidelity: (1) article page, Arabic article, translated view with the bar; (2) the same page in original view (RTL block); (3) the same page with each non-happy state (pending, paused, failed, low trust, English article with no bar); (4) a search results page with one translation match card, one original match card, and the standing note; (5) the 360 px mobile version of (1). Questions to answer: does the toggle sit well above long text, does the page jump on swap, is "Machine translated" visible without scrolling, does the English headline line on cards add clutter, and can the "About this" disclosure be found without competing with the text.

## 14. Decisions needed and open questions
- Decided: English headline line on all foreign cards with a translation (ADR-0026).
- Sticky toggle for long articles: default end-of-text repeat; sticky is optional, UNCONFIRMED.
- Remember "show original" per session: not in the first version.
- Decided: NOT applies to the original text only (ADR-0027).
- Side-by-side view: out of scope for now.
