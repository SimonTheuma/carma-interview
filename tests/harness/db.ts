import pg from "pg";
import { migrate, defaultMigrationsDir } from "@/lib/db/migrate";

export { seedArticles, rng } from "./seed";
export type { SeedResult } from "./seed";

export type TestDb = {
  pool: pg.Pool;
  admin: pg.Client;
  dbName: string;
  end: () => Promise<void>;
};

function adminConfig() {
  return {
    host: process.env.TEST_DB_HOST ?? process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.TEST_DB_PORT ?? process.env.DB_PORT ?? 5432),
    user: process.env.TEST_DB_USER ?? "mss_admin",
    password:
      process.env.TEST_DB_PASSWORD ??
      process.env.DB_PASSWORD ??
      process.env.POSTGRES_PASSWORD ??
      "",
    database: process.env.TEST_DB_ADMIN_DB ?? "postgres",
  };
}

/** Returns null when Postgres is unreachable (integration suite should skip). */
export async function tryConnectAdmin(): Promise<pg.Client | null> {
  const cfg = adminConfig();
  if (!cfg.password && !process.env.TEST_DB_ALLOW_TRUST) {
    // Still try — local trust auth may work
  }
  const client = new pg.Client(cfg);
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

export async function createTestDb(): Promise<TestDb | null> {
  const admin = await tryConnectAdmin();
  if (!admin) return null;

  const dbName = `mss_it_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);

  const migrateClient = new pg.Client({ ...adminConfig(), database: dbName });
  await migrateClient.connect();
  try {
    await migrate(migrateClient, defaultMigrationsDir());
    await migrateClient.query(
      `INSERT INTO system_flags (key, value) VALUES ('enrichment_enabled', 'true')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const { refreshCoverageFlags } = await import("@/worker/metrics-refresh");
    await refreshCoverageFlags(migrateClient);
  } finally {
    await migrateClient.end();
  }

  const pool = new pg.Pool({
    ...adminConfig(),
    database: dbName,
    max: 4,
  });

  return {
    pool,
    admin,
    dbName,
    async end() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function assertIngestConservation(
  pool: pg.Pool,
  batchId: string,
): Promise<{ received: number; admitted: number; quarantined: number; duplicate: number }> {
  const res = await pool.query<{ outcome: string; n: string }>(
    `SELECT outcome, count(*)::text AS n FROM ingest_events WHERE batch_id = $1::uuid GROUP BY outcome`,
    [batchId],
  );
  const counts = { admitted: 0, quarantined: 0, duplicate: 0 };
  for (const r of res.rows) {
    if (r.outcome === "admitted") counts.admitted = Number(r.n);
    if (r.outcome === "quarantined") counts.quarantined = Number(r.n);
    if (r.outcome === "duplicate") counts.duplicate = Number(r.n);
  }
  const received = counts.admitted + counts.quarantined + counts.duplicate;
  const articles = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM articles a
      JOIN ingest_events e ON e.article_id = a.id
     WHERE e.batch_id = $1::uuid AND e.outcome = 'admitted'`,
    [batchId],
  );
  if (Number(articles.rows[0]!.n) !== counts.admitted) {
    throw new Error(
      `INV-1 articles ${articles.rows[0]!.n} != admitted ${counts.admitted} for batch ${batchId}`,
    );
  }
  return { received, ...counts };
}
