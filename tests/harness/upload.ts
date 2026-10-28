import type { AppConfig } from "@/lib/config";
import { loadConfig } from "@/lib/config";
import type { TestDb } from "./db";

export function testUploadConfig(db: TestDb): AppConfig {
  const base = loadConfig({
    NODE_ENV: "test",
    ROLE: "web",
    DB_HOST: process.env.TEST_DB_HOST ?? "127.0.0.1",
    DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "",
    UPLOAD_ENABLED: "true",
    ENRICHMENT_MODE: "mock",
  } as NodeJS.ProcessEnv);
  return {
    ...base,
    db: { ...base.db, name: db.dbName, user: "mss_admin" },
    ingestPool: { ...base.ingestPool, password: base.db.password || "x" },
    promptVersion: "v1",
  };
}

export function jsonUploadRequest(body: unknown): Request {
  return new Request("http://localhost/api/uploads", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
