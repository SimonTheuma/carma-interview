# Article translation implementation
_Exported on 10/28/2026 at 21:53:43 GMT+1 from Cursor (3.20.17)_

---

**User**

can we implement @.specs/plan/0003-article-translation.md?

---

**Cursor**

I'll read the plan spec and map it against the current codebase so we can confirm a concrete implementation approach.

The execution plan is large (~90–120h, 8 phases). I'll check a few blockers and the current codebase so we can scope what to implement first.

Yes — the plan is ready to execute. Two scope choices before I lock the implementation plan:

Yes — [`.specs/plan/0003-article-translation.md`](.specs/plan/0003-article-translation.md) is implementable. B2 is settled (ADR-0029 additive caps), the codebase still only has `sentiment` / `summary_topics`, and the mock path covers P1–P7 without `OPENAI_MODEL`.

Two scope choices before I lock the Cursor plan:

**1. How far should this first pass go?** (~90–120h total; the plan says phase-by-phase with human checkpoints)

- **Phase 1 only** — helpers, config, migration `0004` — stop for review  
- **Phases 1–2** — schema + enqueue — stop at the ingest benchmark gate  
- **Phases 1–4** — through end-to-end translate save — pause before search/UI  
- **Full plan through Phase 8** — mock path; real-model calibration (T8.3) later if `OPENAI_MODEL` is unset  

**2. Optionals?**

- Plan defaults: include **T6.7** reveal beacon; skip **T8.7** CI  
- Both  
- Neither  
- CI only  

Reply with your picks (e.g. “1–4, defaults”) and I’ll produce the concrete implementation plan.

---

**User**

full plan through phase 8.

plan defaults are okay

---

**Cursor**

Full plan through Phase 8 with the defaults — I'll lock that into a concrete implementation plan against the current codebase.

---

**User**

Implement the plan as specified, it is attached for your reference. Do NOT edit the plan file itself.

To-do's from the plan have already been created. Do not create them again. Mark them as in_progress as you work, starting with the first one. Don't stop until you have completed all the to-dos.

---

**Cursor**

Starting Phase 1: helpers, config, and schema. I'll mark that todo in progress and gather the specs and code patterns we need.

Implementing Phase 1 helpers and config first, then the migration.

Writing migration `0004` and reading the full `ingest_new_version` function to update.

Phase 1 schema and Phase 2 enqueue are in place. Moving on to the worker translation lane (Phases 3–4).

Implementing the translate core (chunker, prompt, validators) and wiring the worker lane.

Rewriting the worker loop for the translation lane and early claim-client release.

Building the UI layer next: strings, translation components, and article/search page updates.

The sweeper needs `DELETE` on `article_translations`; the migration only granted insert/update. Adding a follow-up grant migration.

Translation jobs should use `TRANSLATE_PROMPT_VERSION`. Fixing enqueue, then marking todos complete.

Article translation is implemented through Phase 8 and running on the local stack.

### What’s in place
- **Schema:** migrations `0004`–`0006` (`article_translations`, chunk cache, grants, `ingest_new_version(..., p_needs_translation)`)
- **Ingest:** multi-row job insert; foreign articles get a `translation` job
- **Worker:** translate lane (chunk → validate → cache → save), separate `openai-translate` budget/breaker, claim client released after COMMIT
- **Search:** original OR translation match; `matched_in` + `headline_en`; untranslated breakdown
- **UI:** translation-first article page with toggle, search card markers, `UntranslatedNote`, reveal beacon
- **Ops:** readyz checks the table; alerts T1–T8; Grafana translation row; README/docs

### Verified live
Arabic article `61` translated successfully; page title uses English; search returns `matched_in: "both"` and `headline_en`. **87** unit tests pass.

### Follow-ups (human / optional)
Recorded in [`reports/translation-phase-gates.md`](reports/translation-phase-gates.md): HP-1 100k ingest bench, 200k search plan experiment, full Playwright/axe, carma-review. T8.7 CI skipped; T8.3 calibration notes in [`reports/translation-t8.3-deferred.md`](reports/translation-t8.3-deferred.md).

**Kill switch:** `UPDATE system_flags SET value='false' WHERE key='translation_enabled'`

