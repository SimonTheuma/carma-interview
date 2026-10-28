import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "../harness/db";

const dbPromise = createTestDb();

describe("upload grants", () => {
  let db: TestDb | null = null;

  beforeAll(async () => {
    db = await dbPromise;
  });

  afterAll(async () => {
    await db?.end();
  });

  it("skips when Postgres unavailable", async () => {
    if (db) return;
    expect(db).toBeNull();
  });

  it("E7 app_ingest cannot UPDATE articles directly; app_read cannot call ingest_new_version", async () => {
    if (!db) return;
    // Set role passwords so we can connect as app roles (migrate already created roles).
    await db.pool.query(`SELECT set_role_password('app_ingest', 'ingest-test-pw')`);
    await db.pool.query(`SELECT set_role_password('app_read', 'read-test-pw')`);

    const ingest = await db.pool.connect();
    try {
      await ingest.query(`SET ROLE app_ingest`);
      let denied = false;
      try {
        await ingest.query(`UPDATE articles SET language = language WHERE false`);
      } catch {
        denied = true;
      }
      // Even with WHERE false, lack of privilege raises before execution on some PG versions;
      // also try a real update path via has_table_privilege.
      const priv = await ingest.query<{ ok: boolean }>(
        `SELECT has_table_privilege('app_ingest', 'articles', 'UPDATE') AS ok`,
      );
      expect(priv.rows[0]!.ok || denied).toBe(false);
      expect(priv.rows[0]!.ok).toBe(false);
    } finally {
      await ingest.query(`RESET ROLE`).catch(() => undefined);
      ingest.release();
    }

    const read = await db.pool.connect();
    try {
      await read.query(`SET ROLE app_read`);
      const canEvents = await read.query<{ ok: boolean }>(
        `SELECT has_table_privilege('app_read', 'ingest_events', 'SELECT') AS ok`,
      );
      expect(canEvents.rows[0]!.ok).toBe(false);

      let fnDenied = false;
      try {
        await read.query(
          `SELECT * FROM ingest_new_version(
             1::bigint, gen_random_uuid(), 'backfill', 0, decode('aa','hex'), 1,
             decode('bb','hex'), now(), 'en', 'h', 'b', '{}', 'h b', 1::smallint,
             '[]'::jsonb, 'v1', true
           )`,
        );
      } catch {
        fnDenied = true;
      }
      expect(fnDenied).toBe(true);

      const canVersions = await read.query<{ ok: boolean }>(
        `SELECT has_table_privilege('app_read', 'article_versions', 'SELECT') AS ok`,
      );
      expect(canVersions.rows[0]!.ok).toBe(true);
    } finally {
      await read.query(`RESET ROLE`).catch(() => undefined);
      read.release();
    }
  });
});
