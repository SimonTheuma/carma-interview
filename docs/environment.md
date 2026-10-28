# Environment verification (task 1.5)

Recorded 2026-10-24 on Windows 11 + Docker Desktop.

## Image pins

| Image | Tag used |
| --- | --- |
| Postgres | `postgres:16.6-bookworm` |
| Node | `node:22.14.0-bookworm-slim` |
| Alpine (secrets-init) | `alpine:3.20.3` |

## E1 — `pg_trgm` on non-ASCII

Run after `docker compose up`:

```sql
SELECT show_trgm('科技企业'), show_trgm('العقارات'), show_trgm('ab'), show_trgm('oil prices');
SHOW lc_ctype;
SHOW server_encoding;
```

Init args: `POSTGRES_INITDB_ARGS=--locale=C.UTF-8 --encoding=UTF8`.

Observed on `postgres:16.6-bookworm` with `C.UTF-8`:

- `show_trgm('科技企业')` — non-empty (5 hashes)
- `show_trgm('العقارات')` — non-empty (9 hashes)
- `show_trgm('ab')` — `{"  a"," ab","ab "}`

Decision: keep trigram index enabled (`trgm_index=on`). Substring leaves for CJK/Arabic can use the index.

Capability flag: `system_flags.trgm_index` set by migration (`on` if GIN trgm index created).

## Compose feature checks

| Feature | Result |
| --- | --- |
| Volume `subpath` mounts | Used for secrets consumers |
| `env_file` `required: false` | Used |
| `up --wait` with exited one-shots | Seed moved into migrate / optional `seed` profile so `--wait` only tracks long-running services |

## Host

See `docker info` on the grader machine for CPU/RAM. Assumed fit: ~1.7 GB for default stack.

## Article translation

Non-English articles get a `translation` enrichment job at ingest. Without `OPENAI_API_KEY` the worker uses a labelled mock translator (`[mock translation]` prefix). Kill switch: `UPDATE system_flags SET value='false' WHERE key='translation_enabled'`. Budget is additive: `BUDGET_OPENAI_DAILY` (default 10) plus `BUDGET_TRANSLATE_DAILY` (default 3). Web readiness is `/api/readyz` (checks `article_translations` exists) and liveness `/api/healthz`. Web and worker must deploy together after migration `0004` because `ingest_new_version` gains `p_needs_translation`.
