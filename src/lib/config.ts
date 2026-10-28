import { readFileSync } from "node:fs";
import { z } from "zod";

function readOptionalFile(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function envOrFile(name: string, fileName?: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined && direct !== "") return direct;
  const fileEnv = fileName ?? `${name}_FILE`;
  return readOptionalFile(process.env[fileEnv]);
}

const money = z.coerce.number().nonnegative().optional();

/** Parse "min,max" ratio bounds ("Infinity" allowed for max, i.e. no upper cap); throws with the variable name when invalid. */
export function parseRatioBounds(raw: string, varName: string): { min: number; max: number } {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length !== 2) {
    throw new Error(
      `Configuration error: ${varName} must be "min,max" (got ${JSON.stringify(raw)}).`,
    );
  }
  const min = Number(parts[0]);
  const max = Number(parts[1]);
  if (!Number.isFinite(min) || Number.isNaN(max) || min < 0 || max < 0 || !(min < max)) {
    throw new Error(
      `Configuration error: ${varName} must be "min,max" with min < max (got ${JSON.stringify(raw)}).`,
    );
  }
  return { min, max };
}

const rawSchema = z.object({
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DB_HOST: z.string().default("db"),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_NAME: z.string().default("mss"),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_PASSWORD_FILE: z.string().optional(),
  CURSOR_SECRET: z.string().optional(),
  CURSOR_SECRET_FILE: z.string().optional(),
  ENRICHMENT_MODE: z.enum(["auto", "mock", "real"]).default("auto"),
  ENRICHMENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  SEED_SAMPLE: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  JEV_API_KEY: z.string().optional(),
  JEV_MODEL: z.string().default("jev-latest"),
  JEV_BASE_URL: z.string().default("https://api.typesafe.ai/v1/systemone"),
  JEV_PRICE_IN_PER_MTOK: money,
  JEV_PRICE_OUT_PER_MTOK: money,
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  OPENAI_PRICE_IN_PER_MTOK: money,
  OPENAI_PRICE_OUT_PER_MTOK: money,
  BUDGET_CURRENCY: z.string().default("USD"),
  BUDGET_JEV_DAILY: z.coerce.number().nonnegative().default(5),
  BUDGET_OPENAI_DAILY: z.coerce.number().nonnegative().default(10),
  BUDGET_TRANSLATE_DAILY: z.coerce.number().nonnegative().default(3),
  INPUT_TOKEN_CAP: z.coerce.number().int().positive().default(4000),
  WORKER_CONCURRENCY_JEV: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY_OPENAI: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY_TRANSLATE: z.coerce.number().int().positive().default(2),
  RPM_JEV: z.coerce.number().int().positive().default(60),
  RPM_OPENAI: z.coerce.number().int().positive().default(60),
  RPM_TRANSLATE: z.coerce.number().int().positive().default(60),
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
  CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CLAIM_VISIBILITY_SECONDS: z.coerce.number().int().positive().default(180),
  PROMPT_VERSION: z.string().default("v1"),
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(50),
  LOG_LEVEL: z.string().default("info"),
  TRANSLATION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  TRANSLATE_MODEL: z.string().optional(),
  TRANSLATE_CHUNK_TOKENS: z.coerce.number().int().positive().default(1500),
  TRANSLATE_MAX_CHUNKS: z.coerce.number().int().positive().default(20),
  TRANSLATE_RATIO_CJK: z.string().default("0.15,Infinity"),
  TRANSLATE_RATIO_OTHER: z.string().default("0.3,3.0"),
  TRANSLATE_CACHE_DAYS: z.coerce.number().int().positive().default(7),
  TRANSLATE_SUPERSEDED_DAYS: z.coerce.number().int().positive().default(30),
  TRANSLATE_PROMPT_VERSION: z.string().default("t1"),
  ROLE: z.enum(["web", "worker", "migrate", "seed", "cli"]).default("cli"),
  UPLOAD_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(25 * 1024 * 1024).default(5_242_880),
  UPLOAD_MAX_ITEMS: z.coerce.number().int().positive().default(1000),
  UPLOAD_MAX_DEPTH: z.coerce.number().int().positive().default(8),
  UPLOAD_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(10),
  UPLOAD_DEADLINE_MS: z.coerce.number().int().positive().default(60_000),
  INGEST_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  INGEST_IDLE_IN_TXN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  INGEST_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  INGEST_DB_PASSWORD: z.string().optional(),
  INGEST_DB_PASSWORD_FILE: z.string().optional(),
});

export type ProviderMode = "real" | "mock";

export type AppConfig = {
  webPort: number;
  db: { host: string; port: number; name: string; user: string; password: string };
  cursorSecret: string;
  enrichmentMode: "auto" | "mock" | "real";
  enrichmentEnabled: boolean;
  seedSample: boolean;
  jev: {
    mode: ProviderMode;
    apiKey?: string;
    model: string;
    baseUrl: string;
    priceInPerMtok?: number;
    priceOutPerMtok?: number;
  };
  openai: {
    mode: ProviderMode;
    apiKey?: string;
    model?: string;
    priceInPerMtok?: number;
    priceOutPerMtok?: number;
  };
  budget: { currency: string; jevDaily: number; openaiDaily: number; translateDaily: number };
  inputTokenCap: number;
  workerConcurrency: { jev: number; openai: number; translate: number };
  rpm: { jev: number; openai: number; translate: number };
  maxAttempts: number;
  callTimeoutMs: number;
  claimVisibilitySeconds: number;
  promptVersion: string;
  mockLatencyMs: number;
  logLevel: string;
  role: "web" | "worker" | "migrate" | "seed" | "cli";
  translation: {
    enabled: boolean;
    model?: string;
    chunkTokens: number;
    maxChunks: number;
    ratioCjk: { min: number; max: number };
    ratioOther: { min: number; max: number };
    cacheDays: number;
    supersededDays: number;
    promptVersion: string;
  };
  upload: {
    enabled: boolean;
    maxBytes: number;
    maxItems: number;
    maxDepth: number;
    rateLimitPerHour: number;
    deadlineMs: number;
  };
  ingestPool: {
    statementTimeoutMs: number;
    idleInTxnTimeoutMs: number;
    lockTimeoutMs: number;
    password: string | null;
  };
};

function resolveProviderMode(
  globalMode: "auto" | "mock" | "real",
  hasKey: boolean,
  label: string,
): ProviderMode {
  if (globalMode === "mock") return "mock";
  if (globalMode === "real") {
    if (!hasKey) {
      throw new Error(
        `Configuration error: ${label} API key is required when ENRICHMENT_MODE=real. Add it to .env (see .env.example).`,
      );
    }
    return "real";
  }
  return hasKey ? "real" : "mock";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuration error: ${msg}`);
  }
  const r = parsed.data;

  const jevKey = envOrFile("JEV_API_KEY") ?? r.JEV_API_KEY;
  const openaiKey = envOrFile("OPENAI_API_KEY") ?? r.OPENAI_API_KEY;
  const dbPassword =
    envOrFile("DB_PASSWORD", "DB_PASSWORD_FILE") ??
    r.DB_PASSWORD ??
    readOptionalFile(r.DB_PASSWORD_FILE) ??
    "";
  const cursorSecret =
    envOrFile("CURSOR_SECRET", "CURSOR_SECRET_FILE") ??
    r.CURSOR_SECRET ??
    readOptionalFile(r.CURSOR_SECRET_FILE) ??
    "dev-cursor-secret-change-me";

  const ingestDbPassword =
    envOrFile("INGEST_DB_PASSWORD", "INGEST_DB_PASSWORD_FILE") ??
    r.INGEST_DB_PASSWORD ??
    readOptionalFile(r.INGEST_DB_PASSWORD_FILE) ??
    null;

  const uploadEnabled = r.UPLOAD_ENABLED ?? true;

  const jevMode = resolveProviderMode(r.ENRICHMENT_MODE, Boolean(jevKey), "JEV");
  const openaiMode = resolveProviderMode(r.ENRICHMENT_MODE, Boolean(openaiKey), "OPENAI");

  if (openaiMode === "real") {
    if (!r.OPENAI_MODEL) {
      throw new Error(
        "Configuration error: OPENAI_MODEL is required when OPENAI_API_KEY is set. Add it to .env (see .env.example).",
      );
    }
    if (r.OPENAI_PRICE_IN_PER_MTOK === undefined || r.OPENAI_PRICE_OUT_PER_MTOK === undefined) {
      throw new Error(
        "Configuration error: OPENAI_PRICE_IN_PER_MTOK and OPENAI_PRICE_OUT_PER_MTOK are required in real mode.",
      );
    }
  }
  if (jevMode === "real") {
    if (r.JEV_PRICE_IN_PER_MTOK === undefined || r.JEV_PRICE_OUT_PER_MTOK === undefined) {
      throw new Error(
        "Configuration error: JEV_PRICE_IN_PER_MTOK and JEV_PRICE_OUT_PER_MTOK are required in real mode.",
      );
    }
  }

  if (r.CLAIM_VISIBILITY_SECONDS * 1000 < r.CALL_TIMEOUT_MS) {
    throw new Error(
      `Configuration error: CLAIM_VISIBILITY_SECONDS (${r.CLAIM_VISIBILITY_SECONDS}s) must cover CALL_TIMEOUT_MS (${r.CALL_TIMEOUT_MS}ms).`,
    );
  }

  const ratioCjk = parseRatioBounds(r.TRANSLATE_RATIO_CJK, "TRANSLATE_RATIO_CJK");
  const ratioOther = parseRatioBounds(r.TRANSLATE_RATIO_OTHER, "TRANSLATE_RATIO_OTHER");

  const dbUser =
    r.DB_USER ??
    (r.ROLE === "web"
      ? "app_read"
      : r.ROLE === "worker"
        ? "app_worker"
        : r.ROLE === "seed"
          ? "app_ingest"
          : r.ROLE === "migrate"
            ? "mss_admin"
            : "app_read");

  return {
    webPort: r.WEB_PORT,
    db: {
      host: r.DB_HOST,
      port: r.DB_PORT,
      name: r.DB_NAME,
      user: dbUser,
      password: dbPassword,
    },
    cursorSecret,
    enrichmentMode: r.ENRICHMENT_MODE,
    enrichmentEnabled: r.ENRICHMENT_ENABLED ?? true,
    seedSample: r.SEED_SAMPLE ?? true,
    jev: {
      mode: jevMode,
      ...(jevKey !== undefined ? { apiKey: jevKey } : {}),
      model: r.JEV_MODEL,
      baseUrl: r.JEV_BASE_URL,
      ...(r.JEV_PRICE_IN_PER_MTOK !== undefined ? { priceInPerMtok: r.JEV_PRICE_IN_PER_MTOK } : {}),
      ...(r.JEV_PRICE_OUT_PER_MTOK !== undefined ? { priceOutPerMtok: r.JEV_PRICE_OUT_PER_MTOK } : {}),
    },
    openai: {
      mode: openaiMode,
      ...(openaiKey !== undefined ? { apiKey: openaiKey } : {}),
      ...(r.OPENAI_MODEL !== undefined ? { model: r.OPENAI_MODEL } : {}),
      ...(r.OPENAI_PRICE_IN_PER_MTOK !== undefined
        ? { priceInPerMtok: r.OPENAI_PRICE_IN_PER_MTOK }
        : {}),
      ...(r.OPENAI_PRICE_OUT_PER_MTOK !== undefined
        ? { priceOutPerMtok: r.OPENAI_PRICE_OUT_PER_MTOK }
        : {}),
    },
    budget: {
      currency: r.BUDGET_CURRENCY,
      jevDaily: r.BUDGET_JEV_DAILY,
      openaiDaily: r.BUDGET_OPENAI_DAILY,
      translateDaily: r.BUDGET_TRANSLATE_DAILY,
    },
    inputTokenCap: r.INPUT_TOKEN_CAP,
    workerConcurrency: {
      jev: r.WORKER_CONCURRENCY_JEV,
      openai: r.WORKER_CONCURRENCY_OPENAI,
      translate: r.WORKER_CONCURRENCY_TRANSLATE,
    },
    rpm: { jev: r.RPM_JEV, openai: r.RPM_OPENAI, translate: r.RPM_TRANSLATE },
    maxAttempts: r.MAX_ATTEMPTS,
    callTimeoutMs: r.CALL_TIMEOUT_MS,
    claimVisibilitySeconds: r.CLAIM_VISIBILITY_SECONDS,
    promptVersion: r.PROMPT_VERSION,
    mockLatencyMs: r.MOCK_LATENCY_MS,
    logLevel: r.LOG_LEVEL,
    role: r.ROLE,
    translation: {
      enabled: r.TRANSLATION_ENABLED ?? true,
      ...(r.TRANSLATE_MODEL !== undefined ? { model: r.TRANSLATE_MODEL } : {}),
      chunkTokens: r.TRANSLATE_CHUNK_TOKENS,
      maxChunks: r.TRANSLATE_MAX_CHUNKS,
      ratioCjk,
      ratioOther,
      cacheDays: r.TRANSLATE_CACHE_DAYS,
      supersededDays: r.TRANSLATE_SUPERSEDED_DAYS,
      promptVersion: r.TRANSLATE_PROMPT_VERSION,
    },
    upload: {
      enabled: uploadEnabled,
      maxBytes: r.UPLOAD_MAX_BYTES,
      maxItems: r.UPLOAD_MAX_ITEMS,
      maxDepth: r.UPLOAD_MAX_DEPTH,
      rateLimitPerHour: r.UPLOAD_RATE_LIMIT_PER_HOUR,
      deadlineMs: r.UPLOAD_DEADLINE_MS,
    },
    ingestPool: {
      statementTimeoutMs: r.INGEST_STATEMENT_TIMEOUT_MS,
      idleInTxnTimeoutMs: r.INGEST_IDLE_IN_TXN_TIMEOUT_MS,
      lockTimeoutMs: r.INGEST_LOCK_TIMEOUT_MS,
      password: ingestDbPassword,
    },
  };
}

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}
