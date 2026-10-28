---
spec: carma-ux
number: 0002
title: Upload page, batch report and version history
status: draft
date: 2026-10-24
feature: json-file-upload
inputs: [.specs/architect/0002-json-file-upload.md, .specs/data/sanitization/0002-json-file-upload.md, .specs/data/dba/0002-json-file-upload.md, .specs/telemetry/0002-json-file-upload.md, .specs/ux/0001-media-signal-service.md]
principles: [P2, P3, P6, P8, P9]
supersedes: null
---

# 0002 Upload page, batch report and version history

## 1. Summary
One new page, `/upload`, where an operator picks a JSON file, enters the upload token, sends it, and gets an honest per-article report that keeps updating until enrichment finishes. Two small changes elsewhere: a nav link, and the article page shows version history and no longer mixes jobs from different versions. Everything else (search, trends, status) is unchanged because `articles` still means "current version" (DBA 0002).

## 2. Users and core intents
| Role | Intent | Rank |
| --- | --- | --- |
| Operator / analyst | "Load this file of articles and know, for every one, whether it got in, why not, and whether it is enriched yet" | **Primary** |
| Operator | "Re-send a corrected file and see which articles changed" | Secondary |
| Developer | "Find what happened to batch X or article Y" (batch id, reason codes, trace link) | Secondary |
Primary intent decides the layout: the report is the page; the form is a compact bar above it.

## 3. Approaches considered
1. **Single page: form on top, report below, live progress (recommended).** One place, matches sync processing (the report arrives with the response) and polling afterwards.
2. Wizard (choose, preview, confirm): safer for large files, but the file is capped at 1000 items, adds clicks, and a preview needs the same validation twice.
3. Drag-drop only with toast result: fast but hides per-article reasons, breaks P3.
Recommendation 1. No user decision needed.

## 4. Information architecture
`/upload` is a new item in the primary nav (`src/components/AppHeader.tsx`), after Status. The report links each row to `/articles/[id]`; quarantined rows link to the Status page's quarantine section. A batch is addressable by `/upload?batch=<uuid>` so a developer can reopen a report (loads from `GET /api/uploads/:batchId`; needs the token only to upload, not to view, since viewing uses the read role and returns no text).

## 5. Page specification: `/upload`
Purpose: send a file, see an accounted-for result.

Layout (top to bottom):
1. **Upload bar**: file picker (accepts `.json`, `application/json`), token field (password type, never stored by the page), "Upload" button. Hint text: "JSON array of articles. Max 5 MiB / 1000 articles. UTF-8 only." (numbers come from config via the API, not hard-coded).
2. **Result summary** (after response): "Received N: admitted A, duplicates D, quarantined Q" with the reconciliation check shown plainly ("All N accounted for"). If `reconciled` is false: a prominent error with the batch id. Plus: "new versions: V" when > 0, and the batch id (copy button).
3. **Enrichment progress**: "Enriched X of A. Waiting Y. Deferred for budget Z. Failed F." with a progress bar and an explicit note when deferral happens ("Daily LLM budget reached; these continue after the UTC reset", from the existing budget banner wording). Updates by polling the batch endpoint every 3 s while anything is open, then stops; shows "Last updated hh:mm:ss".
4. **Report table** (one row per element, in file order): position, outcome badge (Admitted / New version / Duplicate / Quarantined), article id and external id (link), reason codes in words with the code visible on hover/expand, enrichment state per part (sentiment, summary and topics), flags (e.g. possible prompt injection, markup removed). Filter chips: All, Quarantined, New versions, Duplicates, Not enriched. Default sort file order. No article text is shown here.

Reason code wording (from sanitisation spec section 3 and `src/lib/reasons.ts`; every code needs a human sentence, a fallback shows the raw code): e.g. `published_at_no_timezone` -> "published_at has no timezone"; `payload_invalid` -> "Not a valid article object".

States:
| State | Behaviour |
| --- | --- |
| Idle | Form only, plus last batch id remembered in the URL, not in storage |
| Uploading | Button disabled with "Uploading and checking…"; file name and size shown; cannot start another (double-submit guard); a Cancel only aborts the client request and says "The server may have stored some articles; check the batch report" if it had begun |
| File rejected (4xx) | Inline error under the form, no table; names the rule and the fix: "File is larger than 5 MiB", "Not a JSON array", "File is not UTF-8, re-save as UTF-8", "Wrong token", "Another upload is running, retry in a few seconds", "Too many requests, retry after N min". Nothing was stored, and the message says so |
| Server error (5xx / 504) | "The upload did not finish. Some articles may have been stored. Batch <id>" with a "View what was stored" button that loads the batch endpoint; "Re-upload is safe, already stored articles are skipped" |
| Partial success | The normal report; quarantined rows highlighted but the page does not call it a failure |
| Empty array | "File contained no articles" (200, zero rows) |
| Upload disabled | If the API says `upload_disabled`, the form is replaced by an explanation |
| Enrichment unavailable | Rows show "enrichment unavailable (reason)", never an empty cell or a neutral value (P6) |
| Stale poll | If polling fails 3 times, show "Progress not updating" with retry; the summary stays |

Human touchpoint (P9): quarantined rows link to the quarantine review on Status; page text says "Quarantined articles are kept, not lost, and can be reviewed there".

## 6. Component specifications
| Component | New / reuse | Notes |
| --- | --- | --- |
| `UploadForm` | New | File input, token field, submit; owns the request and abort controller; accessible labels; token never put in the URL or storage |
| `BatchSummary` | New | Counts, reconciliation line, batch id with copy |
| `EnrichmentProgress` | New | Progress bar with text equivalent; role=progressbar plus live text |
| `BatchTable` | New | Sortable by position only; filter chips; keyboard navigable |
| `OutcomeBadge`, `ReasonText` | New | Text plus icon, not colour alone |
| `AppHeader` | Reuse | Add link |
| `CoverageLine` / budget banner | Reuse | For deferral message |
| `TextBlock` | Reuse | Article page |
| `VersionList` | New | On `/articles/[id]`: list of versions (number, arrived at, content hash short, flags), current marked; each older version expandable to read-only text via `TextBlock` |

## 7. Key flows
1. **Load a file**: choose file, enter token, upload, read summary (all accounted for), scan quarantined rows, wait for progress to finish, click an article.
2. **Re-send a corrected file**: upload again; rows show "New version" for changed articles and "Duplicate" for unchanged; click a changed article, see version 2 current, version 1 retained, enrichment shown as "not yet enriched" until the new job completes.
3. **Failed request**: error banner, open "View what was stored", re-upload safely.
4. **Investigate**: paste batch id from a log or ticket into `?batch=`, see the same report.

## 8. Principle compliance
| Principle | How met |
| --- | --- |
| P2, P3 | Every element has a row; reconciliation line; whole-file rejects say that nothing was stored; "stored but unreported" is recoverable via batch view |
| P1 | Admitted articles are searchable immediately; page says enrichment follows |
| P6, P7 | Page shows no derived values; the article page keeps showing confidence with "Why?"; after a new version, the old confidence is not shown as current, instead "not yet enriched" |
| P8 | Batch id, link to article, version history with hash, reason codes |
| P9 | Quarantine link; versions are marked "automated enrichment" as elsewhere |
| P5 | Reason text is localisable via `src/lib/ui/strings.ts`; file name is displayed with `dir="auto"` and isolation; no article text on this page |
| P11 | Dense table, keyboard friendly |

## 9. Data requirements
| Field | Source | Gap |
| --- | --- | --- |
| Upload limits (max bytes, items) | New field in `GET /api/uploads/limits` or in the 4xx body | New, from config (architect) |
| Response: `batch_id`, `received`, counts, `reconciled`, per-item list | `POST /api/uploads` | Needs the `loadArticles` per-item change (architect section 4) |
| Per-item enrichment state and version | `upload_batch_status` (DBA 0002 section 9) | New function |
| Reason code sentences | `src/lib/ui/strings.ts` | New strings |
| Version history | `article_versions` (SELECT granted to `app_read`) | New query on the article page |
| Deferred budget banner | `status_snapshot()` `budget` | Exists |
Article page fix: `enrichment_jobs` and `enrichments` lists on `/articles/[id]` must be filtered or grouped by `article_version` (default to the current version; older versions under the version list), otherwise jobs `superseded_version` appear as failures.

## 10. Accessibility and internationalisation
- File input and token have visible labels; errors are announced (`role="alert"`) and linked with `aria-describedby`; the summary and progress are in a polite live region, polled updates announce only on completion to avoid chatter.
- Table: header cells, sortable column states, filter chips as a toggle group; focus returns to the summary after upload.
- Colour never carries outcome alone (badge text + icon); contrast follows the existing tokens; reduced-motion: no animated progress.
- RTL/CJK: UI strings are LTR English for the PoC (as the rest of the app); any displayed names (external id, source, file name) use `dir="auto"` / `<bdi>`. The report shows no article text, which avoids most mixed-direction problems.

## 11. Wireframe brief
Wireframe first: `/upload` in four states (idle, report with mixed outcomes, 4xx rejection, 5xx with "View what was stored"). Second: article page with the version list. Hierarchy: upload bar (compact), summary line (largest), progress, table. Questions for the wireframes: can an operator tell in 3 seconds whether everything was accounted for? Where does the batch id sit so it is easy to quote? Is the "New version" badge distinguishable from "Admitted" without colour? Fidelity: low, structure and content only.

## 12. Decisions needed and open questions
- UNCONFIRMED (recommended defaults, no question blocking): poll every 3 s; page does not remember the token; viewing a batch needs no token.
- Open: should `/upload` be hidden from the nav when `upload_disabled`? Default: shown, with the disabled explanation.
- Open: show version history in the article trace JSON route as well? Default yes (same query).
