// bench-lib.mjs - dependency-free benchmark harness for Carma benchmarks (Node 18+).
// Copy this file next to your bench script in .benchmarks/<feature>/ and import from it.
// It provides: CLI options, seeded article generation, rate-paced load, latency stats,
// error aggregation, threshold checks, and a clear PASS/FAIL console report with exit code.

import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

// ---------- options ----------
export function parseArgs(defaults = {}, argv = process.argv.slice(2)) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=');
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    if (v === 'true') v = true; else if (v === 'false') v = false; else if (v !== '' && !isNaN(Number(v))) v = Number(v);
    opts[key] = v;
  }
  return opts;
}

// ---------- seeded randomness (reproducible runs) ----------
export function rng(seed = 1) {
  let s = seed >>> 0 || 1; // mulberry32
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.pick = (arr) => arr[next.int(arr.length)];
  return next;
}

// ---------- article generation ----------
const FILLER = {
  en: ['markets', 'earnings', 'growth', 'regulators', 'analysts', 'investment', 'demand', 'report', 'sector', 'outlook', 'startup', 'startups', 'enterprise', 'enterprises', 'news', 'capital'],
  ar: ['الأسواق', 'الأرباح', 'النمو', 'المنظمون', 'المحللون', 'الاستثمار', 'الطلب', 'تقرير', 'القطاع', 'التوقعات'],
  zh: ['市场', '收益', '增长', '监管', '分析师', '投资', '需求', '报告', '行业', '前景'],
  fr: ['marchés', 'entreprises', 'croissance', 'investissement', 'demande', 'rapport', 'secteur'],
};
const SEP = { en: ' ', ar: ' ', zh: '' };

/**
 * Generates articles in the agreed schema with planted brand mentions and known duplicates.
 * opts: { seed, langMix: {en,ar,zh}, mentionRate, duplicateRate, brands: [..], bodyWords: [min,max] }
 * Returns an iterator-like object: gen.next() -> { article, planted: string|null, duplicateOf: id|null }
 */
export function articleGenerator(opts = {}) {
  const r = rng(opts.seed ?? 1);
  const langMix = opts.langMix ?? { en: 0.6, ar: 0.2, zh: 0.2 };
  const brands = opts.brands ?? ['Zentrix', 'Qalamar', 'Novaterra'];
  const mentionRate = opts.mentionRate ?? 0.05;
  const duplicateRate = opts.duplicateRate ?? 0.02;
  const [minW, maxW] = opts.bodyWords ?? [40, 200];
  const sources = opts.sources ?? ['SourceA', 'SourceB', 'SourceC', 'SourceD'];
  const startMs = opts.startMs ?? Date.now();
  const recent = [];
  let id = opts.startId ?? 1;
  const pickLang = () => {
    let x = r(), acc = 0;
    for (const [l, p] of Object.entries(langMix)) { acc += p; if (x < acc) return l; }
    return Object.keys(langMix)[0];
  };
  return {
    next(publishedAt = new Date(startMs)) {
      if (recent.length && r() < duplicateRate) {
        const orig = recent[r.int(recent.length)];
        const dup = { ...orig, id: id++, source: r.pick(sources) };
        return { article: dup, planted: null, duplicateOf: orig.id };
      }
      const lang = pickLang();
      const words = FILLER[lang] ?? FILLER.en;
      const n = minW + r.int(maxW - minW + 1);
      const parts = [];
      for (let i = 0; i < n; i++) parts.push(r.pick(words));
      let planted = null;
      if (r() < mentionRate) {
        planted = r.pick(brands);
        parts.splice(r.int(parts.length), 0, planted);
      }
      const article = {
        id: id++,
        headline: `${r.pick(words)} ${r.pick(words)} #${id}`,
        body: parts.join(SEP[lang] ?? ' '),
        source: r.pick(sources),
        published_at: publishedAt.toISOString(),
        language: lang,
      };
      recent.push(article);
      if (recent.length > 1000) recent.shift();
      return { article, planted, duplicateOf: null };
    },
  };
}

export function hashText(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }

// ---------- latency stats ----------
export class Stats {
  constructor() { this.v = []; }
  add(ms) { this.v.push(ms); }
  get count() { return this.v.length; }
  pct(p) {
    if (!this.v.length) return NaN;
    const a = [...this.v].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)];
  }
  summary() {
    return { count: this.count, p50: this.pct(50), p95: this.pct(95), p99: this.pct(99), max: this.pct(100) };
  }
}

// ---------- error aggregation ----------
export class Errors {
  constructor() { this.map = new Map(); this.total = 0; }
  add(e, context) {
    this.total++;
    const key = String(e?.code ? `${e.code}: ${e.message}` : e?.message ?? e).slice(0, 200);
    const cur = this.map.get(key) ?? { count: 0, sample: null };
    cur.count++;
    if (!cur.sample) cur.sample = { context, stack: (e?.stack ?? '').split('\n').slice(0, 4).join('\n') };
    this.map.set(key, cur);
  }
  report() {
    if (!this.total) return;
    console.log(`\n  ERRORS (${this.total} total, ${this.map.size} distinct)`);
    for (const [k, v] of [...this.map].sort((a, b) => b[1].count - a[1].count).slice(0, 10)) {
      console.log(`   x${v.count}  ${k}`);
      if (v.sample?.context !== undefined) console.log(`        e.g. context: ${JSON.stringify(v.sample.context).slice(0, 160)}`);
      if (v.sample?.stack) console.log(v.sample.stack.split('\n').map((l) => '        ' + l).join('\n'));
    }
  }
}

// ---------- rate-paced load ----------
/**
 * Calls work(i) at a target rate (per second) for durationSec with bounded concurrency.
 * work may return a value; thrown errors are counted, not fatal.
 * Returns { sent, ok, failed, elapsedSec, achievedRate, latency: Stats, errors: Errors, results: [] }
 */
export async function runLoad({ work, rate = 100, durationSec = 10, concurrency = 50, warmupSec = 0, keepResults = false }) {
  const latency = new Stats();
  const errors = new Errors();
  const results = [];
  let sent = 0, ok = 0, failed = 0, inflight = 0, i = 0;
  const intervalMs = 1000 / rate;
  const t0 = performance.now();
  const endAt = t0 + (warmupSec + durationSec) * 1000;
  const warmEnd = t0 + warmupSec * 1000;
  const waiters = [];
  const launch = async (n) => {
    const s = performance.now();
    inflight++;
    try {
      const out = await work(n);
      if (s >= warmEnd) { ok++; latency.add(performance.now() - s); if (keepResults) results.push(out); }
    } catch (e) {
      if (s >= warmEnd) { failed++; errors.add(e, { i: n }); }
    } finally {
      inflight--;
      const w = waiters.shift(); if (w) w();
    }
  };
  const all = [];
  while (performance.now() < endAt) {
    const due = t0 + i * intervalMs;
    const now = performance.now();
    if (now < due) { await new Promise((r) => setTimeout(r, Math.max(0, Math.min(due - now, 5)))); continue; }
    if (inflight >= concurrency) await new Promise((r) => waiters.push(r)); // backpressure: rate falls short, and the report shows it
    if (performance.now() >= warmEnd) sent++;
    all.push(launch(i++));
    if (all.length > 5000) all.splice(0, all.length - 1000); // keep memory bounded
  }
  await Promise.allSettled(all);
  const elapsedSec = (performance.now() - warmEnd) / 1000;
  return { sent, ok, failed, elapsedSec, achievedRate: ok / Math.max(elapsedSec, 0.001), latency, errors, results };
}

// ---------- checks and report ----------
export class Report {
  constructor(title, meta = {}) { this.title = title; this.meta = meta; this.checks = []; this.metrics = []; }
  metric(name, value, unit = '') { this.metrics.push({ name, value, unit }); }
  /** op: '<=' | '>=' | '==' ; threshold origin should be 'agreed' or 'proposed' so readers know */
  check(name, actual, op, threshold, { unit = '', origin = 'proposed' } = {}) {
    const pass = op === '<=' ? actual <= threshold : op === '>=' ? actual >= threshold : actual === threshold;
    this.checks.push({ name, actual, op, threshold, unit, origin, pass });
    return pass;
  }
  fmt(x) { return typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(2) : String(x); }
  print() {
    const line = '='.repeat(72);
    console.log(`\n${line}\n  ${this.title}\n${line}`);
    for (const [k, v] of Object.entries(this.meta)) console.log(`  ${k.padEnd(18)} ${v}`);
    if (this.metrics.length) {
      console.log('\n  METRICS');
      for (const m of this.metrics) console.log(`   ${m.name.padEnd(34)} ${this.fmt(m.value)} ${m.unit}`);
    }
    console.log('\n  CHECKS');
    for (const c of this.checks) {
      console.log(`   ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(34)} ${this.fmt(c.actual)}${c.unit} ${c.op} ${this.fmt(c.threshold)}${c.unit}  [${c.origin}]`);
    }
    const failed = this.checks.filter((c) => !c.pass);
    console.log(`\n${line}\n  RESULT: ${failed.length ? `FAIL (${failed.length} of ${this.checks.length} checks failed)` : `PASS (${this.checks.length} checks)`}\n${line}`);
    return failed.length === 0;
  }
  /** prints the report and sets the process exit code (0 pass, 1 fail) */
  finish() { const ok = this.print(); process.exitCode = ok ? 0 : 1; return ok; }
}

/** Conservation: received must equal the sum of accounted-for outcomes. */
export function conservation(report, received, outcomes) {
  const accounted = Object.values(outcomes).reduce((a, b) => a + b, 0);
  report.metric('received', received);
  for (const [k, v] of Object.entries(outcomes)) report.metric(`  outcome: ${k}`, v);
  report.check('conservation (received == accounted)', accounted, '==', received, { origin: 'agreed' });
}

/** Wraps the main function so any uncaught error gives a clear FAIL and non-zero exit. */
export async function main(fn) {
  try { await fn(); }
  catch (e) {
    console.error(`\nBENCHMARK ERROR (not a measured failure; the benchmark could not run)\n  ${e?.stack ?? e}`);
    process.exitCode = 2;
  }
}
