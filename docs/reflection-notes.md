# Reflection notes

Append short notes after each task (what the AI produced, what was fixed, which test caught it).

## Bootstrap

- Started from create-next-app (Next 16.4.3) already present; reshaped to `src/` layout and Compose stack per plan track F.

## Phase notes

- Next 16 `cacheComponents` conflicts with `force-dynamic`; disabled both cacheComponents and partialPrefetching so DB-backed routes stay dynamic.
- Compose `--wait` failed on exited seed one-shot; seed now runs inside migrate when `SEED_SAMPLE=true`, with optional `seed` profile for reloads.
- `app_read` cannot see quarantine tables; added `status_snapshot()` SECURITY DEFINER + `schema_migrations` SELECT for `/api/status` and `/api/readyz`.
- Golden G1/G2 and weekly aggregate `1,3,3,6,6,1` verified against running stack; all 20 articles reached `succeeded` in mock mode.
- esbuild outbase=src fixed CLI/worker bundle paths for Docker.
