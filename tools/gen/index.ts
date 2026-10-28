/**
 * Seeded synthetic article generator for scale measurements (testing §7 / plan 2.6).
 * Usage: npx tsx tools/gen/index.ts --count 1000 --out /tmp/articles.json
 */
import { writeFileSync } from "node:fs";

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sources = ["Reuters", "Bloomberg", "AP", "FT", "Guardian"];
const langs = ["en", "ar", "zh"];
const terms = ["oil prices", "geopolitical", "renewable", "AI", "healthcare", "عقارات", "科技"];

export function generateArticles(count: number, seed = 42) {
  const rand = mulberry32(seed);
  const out = [];
  const start = Date.UTC(2025, 0, 1);
  for (let i = 1; i <= count; i++) {
    const term = terms[Math.floor(rand() * terms.length)]!;
    const lang = langs[Math.floor(rand() * langs.length)]!;
    const day = Math.floor(rand() * 400);
    out.push({
      id: i,
      headline: `Synthetic ${i}: ${term}`,
      body: `Body about ${term}. `.repeat(20),
      source: sources[Math.floor(rand() * sources.length)],
      published_at: new Date(start + day * 86400_000).toISOString(),
      language: lang,
    });
  }
  return out;
}

const args = process.argv.slice(2);
let count = 1000;
let out = "reports/tmp/synthetic.json";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--count") count = Number(args[++i]);
  if (args[i] === "--out") out = args[++i]!;
}
writeFileSync(out, JSON.stringify(generateArticles(count), null, 2));
console.log(`wrote ${count} to ${out}`);
