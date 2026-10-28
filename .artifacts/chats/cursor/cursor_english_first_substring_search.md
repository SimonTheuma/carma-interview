# English first substring search
_Exported on 10/28/2026 at 21:52:05 GMT+1 from Cursor (3.20.17)_

---

**User**

can we implement @.specs/plan/0004-english-first-substring-search.md?

---

**Cursor**

I'll read the plan and the relevant search/code context so we can propose a concrete implementation approach.

There's already migration 0007 and related tests — I'll check what's done versus what's still open.

Most of plan 0004 already landed under the pre–ADR-0036 design; the remaining work is retargeting that code to Amendment B (bare exact, `*` = prefix OR stem). Checking one more detail on the wildcard compile path, then drafting the plan.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

I'll implement Amendment B starting with migration 0007, then the compiler and the rest of the todos.

Next I'll update `run.ts` and the unit tests for the new classification.

Unit tests passed. Updating fixtures, integration tests, UX, and telemetry next.

Integration tests finished suspiciously fast — checking whether the DB harness actually ran or skipped.

The compose DB still has the old trigram index — swapping it for the Amendment B simple FTS index.

Amendment B / ADR-0036 is in place. Bare Latin terms are exact again; stemming is only on `term*`.

**Search / DB**
- Migration [`0007`](db/migrations/0007_english_search_indexes.sql): summary trigram → `derived_values_summary_fts_idx` (`simple`)
- [`leaf.ts`](src/lib/search/leaf.ts) / [`compile.ts`](src/lib/search/compile.ts): bare → exact; `*` → prefix OR English stem; stop-word `*` omits stem
- Compose DB indexes swapped to match

**UI / ops**
- Wildcard tip + “try adding *” empty hint; loose-match/quote tip removed
- Metrics index label `summary_fts`; alert E1 uses `wildcard`
- README search syntax updated

**Tests / report**
- Unit (120) and Amendment B integration goldens/plans/migration passed against disposable Postgres
- Notes in [`reports/english-search-phase1.md`](reports/english-search-phase1.md)

**Note:** Fresh installs get the new 0007. DBs that already applied the old 0007 need the same index swap (already done on your compose `mss` DB).

---

**User**

can we automatically run the search, debounced by half a second, with a loading indicator in the text field

---

**Cursor**

I'll look at how search is triggered today, then wire up a 500ms debounce and a field loading indicator.

Wiring a 500ms auto-search debounce and an in-field spinner while a search is pending or in flight.

Done. Typing now auto-searches after **500ms** of idle (skipped while the query is invalid). Enter, the Search button, and example chips still search immediately.

A spinner appears on the right of the text field while waiting for the debounce or while the request is in flight.

---

**User**

we should extend this to the trends page as well

---

**Cursor**

I'll mirror the search page: 500ms debounce, parse-before-submit, and an in-field spinner on trends.

Trends now matches search: **500ms** auto-run after typing, Enter for immediate submit, spinner in the field while debouncing or fetching, and invalid queries are blocked with an inline parse error.

