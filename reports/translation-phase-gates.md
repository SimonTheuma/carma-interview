# Article translation — phase gate notes

Date: 2026-10-24

## Completed

- Phases 1–8 implemented on the running stack (`0004`–`0006` applied).
- End-to-end smoke: Arabic article id 61 translated (real OpenAI in this environment), article page title uses English headline, search returns `matched_in=both` and `headline_en`.
- Unit tests: 87 passed.
- Kill switch / mock path / additive budget defaults wired.
- T8.3/T8.4 real-model calibration set: see `translation-t8.3-deferred.md` (optional when prices unset; this host had keys so live translate worked).
- T8.7 CI: skipped per plan defaults.

## Deferred / human follow-ups

- HP-1 ingest benchmark at 100k with `--foreign-share` (T2.4 / T8.2).
- Search plan experiment at 200k (T5.3) — OR+EXISTS form shipped as default.
- Full Playwright/axe/360px suite (T8.1) and devops soak (T8.5).
- carma-review of the full diff (T8.2).
- Copy/visual UX checkpoint (T6).

## Migrations

- `0004_article_translations.sql` — schema + enqueue function
- `0005_translation_delete_grant.sql` — DELETE for superseded purge
- `0006_translation_cache_update_grant.sql` — UPDATE for chunk cache upsert
