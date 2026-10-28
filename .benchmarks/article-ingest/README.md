# Benchmark: article ingest (`loadArticles`)

**Question.** Does the initial ingest path keep every article accounted for, and how fast is it, measured against the 800 articles/s target?

**Change under test.** `src/lib/ingest/ingest.ts` (`loadArticles` -> validate, reduce markup, normalise, insert `articles`, `ingest_events`, `ingest_transformations`, `enrichment_jobs`, quarantine). Specs: INV-1 to INV-7 and M-THRU-1 (`.specs/testing/backend/0001`), HP-DB1 (batch insert), HP-5 (sanitiser).

## Approach (what is real, what is stubbed)

- Real: `loadArticles` itself, the real migrations, real PostgreSQL 16.6, the `app_ingest` role (so grants are exercised), the validator, sanitiser and normaliser.
- Stubbed: nothing. Enrichment is not run; only the two queued `enrichment_jobs` rows per article are checked.
- Database: the script creates its own database (`bench_ingest_<random>`) on a **disposable** Postgres, migrates it, and drops it at the end (`--keepDb` to inspect). It refuses non-local hosts unless `BENCH_ALLOW_REMOTE=1`. Migrations create the cluster-level roles `app_ingest`, `app_worker`, `app_read`, which are left behind; use a throwaway cluster.
- Driver: `pg`, already a project dependency. TypeScript is loaded with `tsx` (also already a dependency).

## Load shape

| Setting | Default | Notes |
| --- | --- | --- |
| Target rate | 800 articles/s | the agreed Carma target; use `--rate` for others |
| Duration / warm-up | 20 s / 3 s | warm-up excluded from latency and rate |
| Unit of work | batch of 20 (`--batch`) | one `loadArticles` call per batch, up to 16 in flight (`--concurrency`) |
| Seed | 42 | same seed gives the same corpus |
| Corpus | the 20 sample articles used as templates | bodies repeated 1-8x (about 0.4-3 KB), unique ref per article; English, Arabic, Chinese as in the sample |
| Mix | 5% planted token, 1% invalid (quarantine), 1% redelivery (same id), 2% content duplicate (new id), 5% injected markup | `--planted --invalid --redelivery --contentDup --markup` |

Maximum capacity: `--rate 5000` (the rate check then fails by design; read the achieved rate).

## Completeness checks (against the database, not the benchmark's counters)

All labelled **agreed** (INV-1 conservation and related invariants):

1. `received == admitted + quarantined + duplicate` (from `ingest_events`)
2. `count(articles) == admitted events`, and equals the expected number of unique valid (source, id) pairs
3. quarantined events equal the invalid items sent; `ingest_quarantine` rows match
4. no admitted event without an article; every article has exactly 2 `enrichment_jobs`
5. every planted token is found through the `search_vector` index in its own article
6. plain-text bodies are stored byte-identical (sha256)
7. every article with injected markup has an `ingest_transformations` row

Performance checks: achieved rate >= 95% of target (agreed when the target is 800, otherwise proposed), batch p95 <= 2000 ms (**proposed**), zero errors (proposed).

## Run

```bash
docker run -d --rm --name carma-bench-db -e POSTGRES_PASSWORD=bench -e POSTGRES_USER=bench_admin -e POSTGRES_DB=bench_boot -p 127.0.0.1:54399:5432 --shm-size=256m postgres:16.6-bookworm -c shared_preload_libraries=pg_stat_statements -c shared_buffers=512MB -c max_connections=50 -c wal_compression=on
```

```bash
BENCH_DB_ADMIN_USER=bench_admin BENCH_DB_ADMIN_PASSWORD=bench node --import tsx .benchmarks/article-ingest/bench.mjs
```

Options: `--rate --duration --warmup --concurrency --batch --seed --keepDb`. Env: `BENCH_DB_HOST` (default 127.0.0.1), `BENCH_DB_PORT` (default 54399), `BENCH_DB_ADMIN_USER`, `BENCH_DB_ADMIN_PASSWORD`. Exit code 0 pass, 1 fail, 2 could not run. Stop the database with `docker stop carma-bench-db`.

### B1: ingest with English search indexes (0004)

Run twice on a disposable DB: once after applying migrations through `0006` only (drop `0007` from the migrations dir copy), then again with `0007` present. Compare achieved rows/s; proposed gate is within 15%. Vocabulary includes inflection pairs (`startup`/`startups`, `enterprise`/`enterprises`). Record hardware, PG version, and both rates in `reports/english-search-phase1.md`.

## Caveats (UNCONFIRMED: not yet agreed with the owner)

- Docker Desktop on Windows, one Postgres container on the same machine as the load generator. Not production-like; numbers are comparable only on the same host.
- Postgres tuning is a modest guess, not `db/postgres/*.conf`.
- Small data volume (about 17,000 rows). Index and autovacuum behaviour at tens of millions of rows is not tested.
- Batch size 20 is a choice; real callers may send one at a time (see design implications).
- Table size and WAL per article are indicative only (WAL is the LSN delta over the run, including index maintenance).

## Design implications

- `ingestOne` is not exported and every article costs 4 or more round trips and its own transaction with a checked-out connection. Throughput is bound by the number of connections: 8 connections gave about 740/s, 16 about 1,075/s. Reaching 800/s needs roughly 16 connections here, which is a lot for a 50-connection limit shared with web and worker. A multi-row or `unnest` insert per batch would be the first thing to try (route to carma-dba / carma-architect).
- `loadArticles` processes a batch serially, so a caller that sends one big batch gets no concurrency at all; the benchmark gets its parallelism by calling it from several chunks. If the real entry point is meant to be a bulk path, say so.
- There is a per-article `SELECT ... WHERE content_hash` for the duplicate flag before the insert; it is cheap now and grows with the table (index on `content_hash` is present).
- `loadArticles` returns counts but not timings. Per-stage timing (validate, reduce, insert) is not available, so this benchmark cannot say where the 8 ms per article goes (route to carma-telemetry).
- The sanitiser collapses whitespace in plain text (the benchmark first tripped on this). That is a transformation of text content; confirm it is recorded in `ingest_transformations` or accepted as normalisation.
