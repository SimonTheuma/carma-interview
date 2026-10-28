// Benchmark: initial article ingest (loadArticles) - completeness and throughput.
// Run (from repo root):  node --import tsx .benchmarks/article-ingest/bench.mjs [--rate 800 --duration 20 --batch 20 --seed 42]
// Exit code: 0 = PASS, 1 = FAIL (a threshold was missed), 2 = the benchmark itself could not run.
// See README.md for design, assumptions and the DB it needs.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { parseArgs, rng, runLoad, Report, conservation, main } from './bench-lib.mjs';

const opts = parseArgs({
  rate: 800, duration: 20, warmup: 3, concurrency: 16, batch: 20, seed: 42,
  planted: 0.05, redelivery: 0.01, contentDup: 0.02, markup: 0.05, invalid: 0.01,
  samples: 'data/sample_articles.json', keepDb: false,
});

const { BENCH_DB_HOST: host = '127.0.0.1', BENCH_DB_PORT: port = '54399',
        BENCH_DB_ADMIN_USER: adminUser, BENCH_DB_ADMIN_PASSWORD: adminPassword } = process.env;

await main(async () => {
  if (!adminUser || !adminPassword) {
    throw new Error('BENCH_DB_ADMIN_USER and BENCH_DB_ADMIN_PASSWORD must be set (disposable Postgres only; see README).');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.BENCH_ALLOW_REMOTE !== '1') {
    throw new Error(`Refusing non-local host "${host}". Set BENCH_ALLOW_REMOTE=1 only for a disposable database.`);
  }

  // ---- setup: a private database, migrated, with its own app_ingest password ----
  const dbName = `bench_ingest_${randomBytes(4).toString('hex')}`;
  const appPassword = randomBytes(12).toString('hex');
  const conn = (database, user, password) => ({ host, port: Number(port), database, user, password });
  const admin = new pg.Client(conn('postgres', adminUser, adminPassword));
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbAdmin = new pg.Client(conn(dbName, adminUser, adminPassword));
  await dbAdmin.connect();
  let pool;
  try {
    const { migrate } = await import(pathToFileURL(resolve('src/lib/db/migrate.ts')).href);
    await migrate(dbAdmin, resolve('db/migrations'));
    await dbAdmin.query('SELECT set_role_password($1, $2)', ['app_ingest', appPassword]);

    process.env.ROLE = 'seed';
    process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
    const { loadArticles } = await import(pathToFileURL(resolve('src/lib/ingest/ingest.ts')).href);
    pool = new pg.Pool({ ...conn(dbName, 'app_ingest', appPassword), max: opts.concurrency + 2 });

    // ---- corpus: the 20 sample articles are templates; everything else is derived from them ----
    const samples = JSON.parse(readFileSync(opts.samples, 'utf8'));
    const r = rng(opts.seed);
    const ring = [];                       // recent valid articles, for redeliveries and content duplicates
    const expect = { valid: new Set(), invalid: 0, markup: new Map(), planted: new Map(), bodyHash: new Map(), bodyText: new Map(), missing: 0 };
    let n = 0, attempted = 0;
    const nowMs = Date.now();
    const makeItem = () => {
      const k = n++;
      const roll = r();
      if (roll < opts.invalid) {           // quarantine candidates (validator: source_missing / published_at_no_timezone / no_text)
        expect.invalid++;
        const t = samples[r.int(samples.length)];
        const bad = r.int(3);
        const base = { id: `b${k}`, headline: t.headline, body: t.body, source: t.source, published_at: new Date(nowMs - 60000).toISOString(), language: t.language };
        if (bad === 0) return { ...base, source: '' };
        if (bad === 1) return { ...base, published_at: '2026-07-14T08:30:00' };
        return { ...base, headline: null, body: null };
      }
      if (ring.length && roll < opts.invalid + opts.redelivery) {   // same (source, id) delivered again -> duplicate
        const o = ring[r.int(ring.length)];
        expect.redelivered = (expect.redelivered ?? 0) + 1;
        return { ...o };
      }
      if (ring.length && roll < opts.invalid + opts.redelivery + opts.contentDup) {   // new id, same content -> admitted + duplicate_content flag
        const o = ring[r.int(ring.length)];
        const it = { ...o, id: `b${k}` };
        expect.valid.add(`${it.source}|${it.id}`);
        return it;
      }
      const t = samples[r.int(samples.length)];
      const reps = 1 + r.int(8);           // ~0.4 KB to ~3 KB bodies; the sample alone is not size-representative
      let body = Array(reps).fill(t.body).join(' ') + ` Ref ${k}.`;
      let headline = `${t.headline} (${k})`;
      const tplMarkup = /[<&]/.test(t.body);   // some samples (ids 6, 18) already carry markup: keep tokens out of tags, skip the exact-text check
      let token = null;
      if (r() < opts.planted) {
        token = `zntrx${k}`;
        const sp = tplMarkup ? -1 : body.indexOf(' ', body.length >> 1);   // insert at a word boundary; no doubled spaces (ingest collapses them)
        body = sp < 0 ? `${body} ${token}` : `${body.slice(0, sp + 1)}${token} ${body.slice(sp + 1)}`;
      }
      let markup = tplMarkup;
      if (r() < opts.markup) { body = `<p>${body}</p><script>alert(${k})</script>`; markup = true; }
      const item = { id: `b${k}`, headline, body, source: t.source, published_at: new Date(nowMs - r.int(3600) * 1000).toISOString(), language: t.language };
      expect.valid.add(`${item.source}|${item.id}`);
      if (token) expect.planted.set(token, item.id);
      if (markup && !tplMarkup) expect.markup.set(item.id, item.source);
      if (!markup) expect.bodyHash.set(item.id, createHash('sha256').update(body, 'utf8').digest('hex')); expect.bodyText.set(item.id, body);
      ring.push(item); if (ring.length > 1000) ring.shift();
      return item;
    };

    // ---- load: chunks of `batch` articles, each one a loadArticles call (the real entry point) ----
    const chunkRate = opts.rate / opts.batch;
    const [{ lsn0 }] = (await dbAdmin.query(`SELECT pg_current_wal_lsn()::text lsn0`)).rows.map((x) => ({ lsn0: x.lsn0 }));
    const res = await runLoad({
      rate: chunkRate, durationSec: opts.duration, warmupSec: opts.warmup, concurrency: opts.concurrency,
      work: async () => {
        const items = Array.from({ length: opts.batch }, makeItem);
        attempted += items.length;
        return loadArticles(items, 'live', pool);
      },
    });

    // ---- verify against the system of record (the database), not the benchmark's own counters ----
    const q = async (sql, params) => (await dbAdmin.query(sql, params)).rows;
    const [ev] = await q(`SELECT count(*) FILTER (WHERE outcome='admitted')::int admitted, count(*) FILTER (WHERE outcome='quarantined')::int quarantined,
                                 count(*) FILTER (WHERE outcome='duplicate')::int duplicate, count(*)::int total FROM ingest_events`);
    const [{ articles }] = await q(`SELECT count(*)::int articles FROM articles`);
    const [{ quar }] = await q(`SELECT count(*)::int quar FROM ingest_quarantine`);
    const [{ jobs }] = await q(`SELECT count(*)::int jobs FROM enrichment_jobs`);
    const [{ orphans }] = await q(`SELECT count(*)::int orphans FROM ingest_events WHERE outcome='admitted' AND article_id IS NULL`);
    const [{ nojobs }] = await q(`SELECT count(*)::int nojobs FROM articles a WHERE (SELECT count(*) FROM enrichment_jobs j WHERE j.article_id=a.id) <> 2`);
    const foundTokens = new Set();
    for (const [token, id] of expect.planted) {   // content duplicates carry the token too, so 1+ hits, and the original must be among them
      const rows = await q(`SELECT external_id FROM articles WHERE search_vector @@ plainto_tsquery('simple', $1)`, [token]);
      if (rows.some((x) => x.external_id === id)) foundTokens.add(token);
      else if (foundTokens.size >= 0 && ++expect.missing <= 3) console.log(`  MISSING token=${token} expected in id=${id}, hits=${rows.length}`);
    }
    const dbRows = await q(`SELECT external_id, language, body, encode(sha256(convert_to(body,'UTF8')),'hex') h FROM articles`);
    const dbHash = new Map(dbRows.map((x) => [x.external_id, x.h]));
    let hashMismatch = 0;
    for (const [id, h] of expect.bodyHash) if (dbHash.has(id) && dbHash.get(id) !== h) { hashMismatch++; if (hashMismatch <= 3) { const got = dbRows.find((x) => x.external_id === id), want = expect.bodyText.get(id); let i = 0; while (got.body[i] === want[i]) i++; console.log(`  MISMATCH id=${id} lang=${got.language} first diff at ${i}: want ${JSON.stringify(want.slice(i, i + 12))} got ${JSON.stringify(got.body.slice(i, i + 12))} (len ${want.length} vs ${got.body.length})`); } }
    const [{ markupRows }] = await q(`SELECT count(DISTINCT article_id)::int "markupRows" FROM ingest_transformations`);
    const [{ walBytes }] = await q(`SELECT (pg_current_wal_lsn() - $1::pg_lsn)::bigint "walBytes"`, [lsn0]);
    const [{ size }] = await q(`SELECT pg_total_relation_size('articles')::bigint size`);

    // ---- report ----
    const report = new Report('Benchmark: article ingest (loadArticles)', {
      database: `${host}:${port}/${dbName} (disposable)`, seed: opts.seed,
      load: `${opts.rate} articles/s target, batch ${opts.batch}, concurrency ${opts.concurrency}`,
      window: `${opts.duration}s measured + ${opts.warmup}s warm-up`,
      node: process.version, host_: `${cpus().length} cpu, ${(totalmem() / 2 ** 30).toFixed(0)} GB RAM, ${process.platform}`,
      corpus: `20 samples -> templates; invalid ${opts.invalid}, redelivery ${opts.redelivery}, content dup ${opts.contentDup}, markup ${opts.markup}, planted ${opts.planted}`,
    });
    const s = res.latency.summary();
    const measuredArticles = res.ok * opts.batch;
    report.metric('achieved throughput', res.achievedRate * opts.batch, 'articles/s');
    report.metric('target throughput', opts.rate, 'articles/s');
    report.metric('batch latency p50', s.p50, 'ms'); report.metric('batch latency p95', s.p95, 'ms');
    report.metric('batch latency p99', s.p99, 'ms'); report.metric('batch latency max', s.max, 'ms');
    report.metric('mean cost per article (batch p50 / size)', s.p50 / opts.batch, 'ms');
    report.metric('articles table total size', Number(size) / 1024 / 1024, 'MB');
    report.metric('WAL written (whole run)', Number(walBytes) / Math.max(ev.total, 1), 'B/article (LSN delta, indicative)');
    report.metric('measured articles', measuredArticles);

    conservation(report, attempted, { admitted: ev.admitted, quarantined: ev.quarantined, duplicate: ev.duplicate });
    report.check('articles rows == admitted events', articles, '==', ev.admitted, { origin: 'agreed' });
    report.check('admitted == expected unique valid', ev.admitted, '==', expect.valid.size, { origin: 'agreed' });
    report.check('quarantined == invalid sent', ev.quarantined, '==', expect.invalid, { origin: 'agreed' });
    report.check('quarantine rows == quarantined events', quar, '==', ev.quarantined, { origin: 'agreed' });
    report.check('admitted events without article', orphans, '==', 0, { origin: 'agreed' });
    report.check('articles without exactly 2 jobs', nojobs, '==', 0, { origin: 'agreed' });
    report.check('planted mentions found in search', foundTokens.size, '==', expect.planted.size, { origin: 'agreed' });
    report.check('plain-text body mismatches (hash)', hashMismatch, '==', 0, { origin: 'agreed' });
    report.check('markup articles with transformation', Math.min(markupRows, expect.markup.size), '==', expect.markup.size, { origin: 'agreed' });
    report.check('errors', res.failed, '==', 0, { origin: 'proposed' });
    report.check('achieved vs target throughput', res.achievedRate * opts.batch, '>=', opts.rate * 0.95, { unit: '/s', origin: opts.rate === 800 ? 'agreed' : 'proposed' });
    report.check('batch p95 latency', s.p95, '<=', 2000, { unit: 'ms', origin: 'proposed' });
    res.errors.report();
    report.finish();
  } finally {
    await pool?.end().catch(() => {});
    await dbAdmin.end().catch(() => {});
    if (!opts.keepDb) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch((e) => console.error('cleanup failed:', e.message));
    await admin.end().catch(() => {});
  }
});
