import pg from "pg";
import type { AppConfig } from "../config";

const { Pool } = pg;

export type Db = pg.Pool | pg.PoolClient;

export function createPool(
  config: AppConfig["db"],
  applicationName: string,
  maxConnections?: number,
): pg.Pool {
  const defaultMax = applicationName.startsWith("web") ? 10 : 6;
  return new Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    application_name: applicationName,
    max: maxConnections ?? defaultMax,
  });
}

/** Ingest pool for the upload route: app_ingest + statement/lock timeouts. */
export function createIngestPool(config: AppConfig, applicationName = "web-ingest"): pg.Pool {
  const password = config.ingestPool.password ?? config.db.password;
  return new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.name,
    user: "app_ingest",
    password,
    application_name: applicationName,
    max: 4,
    options: [
      `-c statement_timeout=${config.ingestPool.statementTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${config.ingestPool.idleInTxnTimeoutMs}`,
      `-c lock_timeout=${config.ingestPool.lockTimeoutMs}`,
    ].join(" "),
  });
}

let webPool: pg.Pool | undefined;
let webPoolKey: string | undefined;
let webIngestPool: pg.Pool | undefined;
let webIngestKey: string | undefined;

/** Process-wide pool for Next.js request handlers (avoids connect+end per request). */
export function getWebPool(config: AppConfig["db"]): pg.Pool {
  const key = `${config.host}:${config.port}/${config.name}:${config.user}`;
  if (!webPool || webPoolKey !== key) {
    void webPool?.end().catch(() => undefined);
    webPool = createPool(config, "web");
    webPoolKey = key;
  }
  return webPool;
}

export function getWebIngestPool(config: AppConfig): pg.Pool {
  const password = config.ingestPool.password ?? config.db.password;
  const key = `${config.db.host}:${config.db.port}/${config.db.name}:app_ingest:${password}`;
  if (!webIngestPool || webIngestKey !== key) {
    void webIngestPool?.end().catch(() => undefined);
    webIngestPool = createIngestPool(config, "web-ingest");
    webIngestKey = key;
  }
  return webIngestPool;
}

export async function query<T extends pg.QueryResultRow>(
  db: Db,
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return db.query<T>(text, params);
}
