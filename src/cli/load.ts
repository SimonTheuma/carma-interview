/**
 * Sample loader CLI. Full ingest pipeline lands in phase 2;
 * this stub exits 0 when SEED_SAMPLE is false or the file is missing until then.
 */
import { existsSync } from "node:fs";
import { log } from "../lib/log";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let file = "data/sample_articles.json";
  let kind = "backfill";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) {
      file = args[++i]!;
    } else if (args[i] === "--kind" && args[i + 1]) {
      kind = args[++i]!;
    }
  }

  if (process.env.SEED_SAMPLE === "false") {
    log.info("SEED_SAMPLE=false; skip load");
    return;
  }

  if (!existsSync(file)) {
    log.warn({ file }, "sample file missing; skip seed until ingest is wired");
    return;
  }

  // Dynamic import so the image builds before phase 2 completes.
  try {
    const { loadArticlesFile } = await import("../lib/ingest/ingest");
    const result = await loadArticlesFile(file, kind === "live" ? "live" : "backfill");
    log.info(result, "seed complete");
    console.log(
      `received ${result.received}, admitted ${result.admitted}, quarantined ${result.quarantined}, duplicate ${result.duplicate}`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      log.warn("ingest module not ready; skip seed");
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  log.error({ err }, "load failed");
  process.exit(1);
});
