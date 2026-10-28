import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { log } from "../log";

const LOCK_KEY = 0x4d_53_53_01; // MSS1

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function migrate(
  client: pg.PoolClient | pg.Client,
  migrationsDir: string,
): Promise<MigrationResult> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const filename of files) {
      const content = readFileSync(join(migrationsDir, filename), "utf8");
      const sum = checksum(content);
      const existing = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [filename],
      );

      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== sum) {
          throw new Error(
            `Migration ${filename} was edited after apply (checksum mismatch). Refuse to continue.`,
          );
        }
        skipped.push(filename);
        continue;
      }

      const nonTransactional = content.includes("-- no-transaction");
      if (!nonTransactional) {
        await client.query("BEGIN");
      }
      try {
        if (nonTransactional) {
          // Multi-statement simple Query is one implicit transaction; CONCURRENTLY
          // cannot run inside that. Execute statements one at a time.
          for (const stmt of splitSqlStatements(content)) {
            await client.query(stmt);
          }
        } else {
          await client.query(content);
        }
        await client.query(
          "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, sum],
        );
        if (!nonTransactional) {
          await client.query("COMMIT");
        }
        applied.push(filename);
        log.info({ filename }, "migration applied");
      } catch (err) {
        if (!nonTransactional) {
          await client.query("ROLLBACK");
        }
        throw err;
      }
    }

    return { applied, skipped };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? join(process.cwd(), "db", "migrations");
}

/** Split SQL on semicolons outside dollar-quoted and single-quoted strings. */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const line = end === -1 ? sql.slice(i) : sql.slice(i, end + 1);
      buf += line;
      i += line.length;
      continue;
    }
    if (ch === "$") {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          buf += sql.slice(i);
          break;
        }
        buf += sql.slice(i, close + tag.length);
        i = close + tag.length;
        continue;
      }
    }
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < sql.length) {
        buf += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          buf += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      const stmt = buf.trim();
      if (stmt.length) out.push(stmt);
      buf = "";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  const tail = buf.trim();
  if (tail.length) out.push(tail);
  return out;
}
