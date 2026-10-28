# Search and CSP hardening
_Exported on 10/28/2026 at 21:51:19 GMT+1 from Cursor (3.20.17)_

---

**User**

can we implement @.specs/plan/0005-search-and-csp-hardening.md?

---

**Cursor**

I'll read the hardening plan and check how search/CSP currently work so we can turn it into an actionable implementation plan.

Next I'll inspect the current search classifier, compiler, CSP config, and the ADRs so the plan matches what's already in the repo.

Yes — the plan is ready to implement. Gaps are clear in code (`classifyLeaf` still quote-first; static CSP with `unsafe-inline`; NOT note buried). Creating the execution plan next.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

I'll start with T1 (script-first classifier) and work through the plan in order.

Implementing the classifier change and U1/U2 tests first.

T2 is done. Next up: integration tests and the notes/UI track.

Implementing the CSP proxy next.

Stack is up but the image predates our changes — rebuilding so CSP and search land in the containers.

Aggregate's pre-existing 500 aborts smoke before the CSP checks — I'll move those checks earlier so they still run.

Fixing e2e assertions: browsers hide the `nonce` attribute from the DOM API when CSP is active.

Implemented plan 0005. Summary:

### Search (C1 / ADR-0038)
- [`leaf.ts`](src/lib/search/leaf.ts): script-first classification; `\p{S}` excluded from non-Latin
- [`compile.ts`](src/lib/search/compile.ts): whitespace collapse for substring phrases
- [`parse.ts`](src/lib/search/parse.ts): `empty_term` after normalisation
- Quoted/starred Chinese/Arabic now hit articles 8/9 (verified live: `"人工智能"` → article 9)

### NOT visibility (C3 / ADR-0040)
- Notes driven from AST (`substring` / `and_not`), not raw-query regex
- NOT note rendered under “Interpreted as” in [`SearchPage.tsx`](src/components/search/SearchPage.tsx)

### CSP (C2 / ADR-0039)
- New [`src/proxy.ts`](src/proxy.ts): per-request nonce, no `unsafe-inline` in `script-src`
- CSP removed from [`next.config.ts`](next.config.ts)
- Smoke CSP checks run early (aggregate still 500 — pre-existing S2)

### Tests / docs
- Unit: classify, compile, parse, notes, csp-proxy, next-config — **180 passed**
- E2e: `csp.spec.ts` + smoke — **8 passed**
- README search + XSS rows updated

Typecheck clean. Lint still has pre-existing issues outside this change (UploadPage, prompt prefer-const, etc.). No commit made.

---

**User**

I'm getting an aggregate error when trying to add terms for the trend search.

the api call for trends is failing immediately.

---

**Cursor**

That matches the aggregate 500 we saw during smoke. I'll inspect the trends/aggregate route and fix the parameter bind error.

The empty-query path passes `$1`/`$2` while `WHERE true` has no placeholders. Checking how filter params are indexed next.

Root cause: empty trends queries send `$1`/`$2` while `WHERE true` has no placeholders. Fixing param binding and adding a regression test.

Fixed. Empty trends queries were sending two bound params (`$1`/`$2` for date bounds) into SQL that was just `WHERE true` — Postgres rejected that immediately.

**Change in** [`src/app/api/aggregate/route.ts`](src/app/api/aggregate/route.ts):
- Filter-only queries (bounds + total) use only the params the `WHERE` clause actually references
- Series SQL still reserves `$1`/`$2` for bucket bounds and shifts the rest by +2

Verified live: empty `q`, `oil`, and Chinese all return **200**. Stack is rebuilt — reload `/trends` and it should work.

---

**User**

good that this is fixed but don't send an api call on mount if the terms are empty

---

**Cursor**

Client bundle is baked into the Docker image — rebuilding so the change is live.

Done. `/trends` no longer calls `/api/aggregate` when every query is blank — it clears the chart and stays idle until you enter a term.

---

**User**

in the trends inputs, are we following the same logic as the queries? because the stemming doesnt seem to have the same behaviour 

---

**Cursor**

I'll compare how Trends builds and runs queries against the main search path, especially stemming.

Same match rules on both sides — verified with live API (`renewable` → total 1 both; `renew*` → total 2 both). Bare Latin is exact; stemming only with `*`. Trends is missing the search tip and “Interpreted as” echo, which makes that easy to miss. Adding those for parity.

Yes — same parser and compiler (`parseQuery` → `compileAst`). Live check: `renewable` totals **1** on both search and aggregate; `renew*` totals **2** on both.

Stemming only applies with a trailing `*` (ADR-0036). A bare term like `renewable` is exact on the `simple` vector, so it won’t pick up `renewables` / `renewed`.

Trends was missing the search tip and “Interpreted as” echo, so that rule was easy to miss. Those are on the trends inputs now — reload `/trends` and try `renew*` vs `renewable`.

---

**User**

the example i tried in trends is "startups", i expected newsitems containing "startup" to be ambiently included

---

**Cursor**

Checking how `startups` vs `startup` resolve on search and trends under the current rules.

That’s expected under the current rules — not a Trends-vs-Search mismatch.

**Bare `startups` is exact** (ADR-0036): it only matches the whole word `startups`, not `startup`. Live check: search and aggregate both return **0** for `startups` and **1** for `startup` / `startup*` / `startups*` (sample article 10 is “Startup”, singular).

To get ambient stem/prefix matching, use a star:

- `startup*` — prefix + English stem  
- `startups*` — also finds `startup` via the stem half  

Same on Search and Trends; Trends just didn’t surface the tip before. Reopening default stemming for bare terms would mean changing ADR-0036 — say if you want that.

---

**User**

let's not and just mark it as a decision in readme if needed

---

**Cursor**

Kept as-is. README search bullet now states the ADR-0036 decision explicitly: bare `startups` ≠ `startup`; use `startup*` / `startups*` for stem/prefix — same on Search and Trends.

---

**User**

why is the split by dropdown only showing none?

---

**Cursor**

Split by **is** disabled when you’re comparing two or more queries — each query is already its own series, so sentiment/language/topic split is turned off and the control is locked to **None** (with the note under the dropdown).

Use a **single** query (remove the extra compare rows) and Sentiment / Language / Topic should become selectable again.

---

**User**

okay, can you set it to disabled then so it's clearer that there's no choice ti be made?

---

**Cursor**

It's already `disabled` in compare mode — I'll make that state more obvious visually.

Done. While comparing, Split by is muted, `cursor-not-allowed`, and only lists **None** — no other options to pick. Reload `/trends` to see it.

