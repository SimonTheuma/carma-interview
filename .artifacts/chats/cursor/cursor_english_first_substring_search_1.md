# English first substring search
_Exported on 10/28/2026 at 21:53:09 GMT+1 from Cursor (3.20.17)_

---

**User**

let's plan an implementation for @.specs/plan/0004-english-first-substring-search.md

---

**Cursor**

I'll read the spec and map it to the current search/translation code so we can plan a concrete implementation.

Next I'll inspect the current search stack, migrations, and UI so the plan maps cleanly onto existing code.

I have enough context from the carma-plan and current search/UI code. Creating a concrete implementation plan that follows the phase order and locks defaults for open questions.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

I'll start Phase 1 with the seed helper and fixtures, then work through migration, compiler, and the rest of the plan in order.

Implementing core Phase 1 pieces in parallel: fixtures/seed, migration, and the search compiler.

Found that `finish.ts` never clears `is_current` on summaries — fixing that with the seed helper, migration, and compiler.

Cleaning up the migration so concurrent index builds are reliable, then implementing the compiler and seed helper.

Integration tests skip without a host-exposed DB — applying migration 0007 via Compose and finishing remaining close-out items.

Implemented English-first stemmed/substring search across both phases. All unit tests pass (110); images rebuilt and migrated.

### Phase 1 — search data layer
- **Migration** [`db/migrations/0007_english_search_indexes.sql`](db/migrations/0007_english_search_indexes.sql): four concurrent expression indexes (articles / translations / summary FTS + summary trigram), applied on the running DB
- **Compiler** [`src/lib/search/leaf.ts`](src/lib/search/leaf.ts), [`compile.ts`](src/lib/search/compile.ts): `stem_sub` / `short_stem` / exact / substring + summary `EXISTS`; NOT stays original-only; stop-word fallback
- **List query** [`src/lib/search/run.ts`](src/lib/search/run.ts): `body_excerpt_en`, `matched_in` as a side set, `trgm_index` / summary coverage notes
- **FP-DB6**: [`finish.ts`](src/worker/finish.ts) now clears `is_current` before inserting new sentiment/summary/topics
- Seed helper, goldens, plan tests, migration test under `tests/`

### Phase 2 — display & telemetry
- **Headline pair** [`src/lib/translate/headline-pair.ts`](src/lib/translate/headline-pair.ts)
- **English-first card** + two-level reveal: [`ArticleCard.tsx`](src/components/ArticleCard.tsx)
- **Article page**: stacked `<details>` reveal in [`TranslatedText.tsx`](src/components/TranslatedText.tsx)
- **Match marker** for summary combinations; echo tip / loose-match / degraded notes
- Beacons (`original_shown` / `original_hidden` + legacy), metrics, alerts E1–E3, Grafana search row

### Human follow-ups (from the plan)
1. Read EXPLAIN on a ≥20k seed (OR/`EXISTS` vs UNION) — stop if plans look bad  
2. Run B1 ingest ± indexes (instructions in [`.benchmarks/article-ingest/README.md`](.benchmarks/article-ingest/README.md))  
3. Approve architect spec 0004 when ready (C1/C3 wording)

