import pg from "pg";
import { readFileSync } from "node:fs";
import { loadConfig } from "../lib/config";
import { defaultMigrationsDir, migrate } from "../lib/db/migrate";
import { log } from "../lib/log";

async function main(): Promise<void> {
  process.env.ROLE = "migrate";
  const config = loadConfig();
  const password =
    config.db.password ||
    (process.env.DB_PASSWORD_FILE
      ? readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim()
      : "");

  const client = new pg.Client({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: "mss_admin",
    password,
  });
  await client.connect();
  try {
    const result = await migrate(client, defaultMigrationsDir());

    const ingestPw = process.env.APP_INGEST_PASSWORD_FILE
      ? readFileSync(process.env.APP_INGEST_PASSWORD_FILE, "utf8").trim()
      : process.env.APP_INGEST_PASSWORD;
    const workerPw = process.env.APP_WORKER_PASSWORD_FILE
      ? readFileSync(process.env.APP_WORKER_PASSWORD_FILE, "utf8").trim()
      : process.env.APP_WORKER_PASSWORD;
    const readPw = process.env.APP_READ_PASSWORD_FILE
      ? readFileSync(process.env.APP_READ_PASSWORD_FILE, "utf8").trim()
      : process.env.APP_READ_PASSWORD;

    if (ingestPw) await client.query("SELECT set_role_password('app_ingest', $1)", [ingestPw]);
    if (workerPw) await client.query("SELECT set_role_password('app_worker', $1)", [workerPw]);
    if (readPw) await client.query("SELECT set_role_password('app_read', $1)", [readPw]);

    const enabled = process.env.ENRICHMENT_ENABLED !== "false";
    await client.query(
      `INSERT INTO system_flags (key, value) VALUES ('enrichment_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [enabled ? "true" : "false"],
    );

    const translationEnabled = process.env.TRANSLATION_ENABLED !== "false";
    await client.query(
      `INSERT INTO system_flags (key, value) VALUES ('translation_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [translationEnabled ? "true" : "false"],
    );

    log.info(result, "migrate complete");
  } finally {
    await client.end();
  }

  // Seed as app_ingest after migrate (avoids compose --wait failing on a separate one-shot).
  if (process.env.SEED_SAMPLE !== "false") {
    process.env.ROLE = "seed";
    if (process.env.APP_INGEST_PASSWORD_FILE) {
      process.env.DB_PASSWORD_FILE = process.env.APP_INGEST_PASSWORD_FILE;
    }
    // Clear cached config so ROLE/password resolve as app_ingest
    const { resetConfigCache } = await import("../lib/config");
    resetConfigCache();
    try {
      const { loadArticlesFile } = await import("../lib/ingest/ingest");
      const file = process.env.SEED_FILE ?? "/app/data/sample_articles.json";
      const seeded = await loadArticlesFile(file, "backfill");
      log.info(seeded, "seed-after-migrate complete");
      console.log(
        `received ${seeded.received}, admitted ${seeded.admitted}, quarantined ${seeded.quarantined}, duplicate ${seeded.duplicate}`,
      );
    } catch (err) {
      log.warn({ err }, "seed-after-migrate skipped or failed");
    }
  }
}

main().catch((err) => {
  log.error({ err }, "migrate failed");
  process.exit(1);
});
