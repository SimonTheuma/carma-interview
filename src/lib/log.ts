import pino from "pino";

const REDACT_PATHS = [
  "authorization",
  "headers.authorization",
  "req.headers.authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "err.config.headers",
  "err.config.headers.Authorization",
  "err.config.headers.authorization",
  "config.headers.Authorization",
  "config.headers.authorization",
  "x-upload-token",
  "headers.x-upload-token",
  "headers['x-upload-token']",
  "req.headers.x-upload-token",
  "*.headers.x-upload-token",
  "token",
  "*.token",
  "upload_token",
  "*.apiKey",
  "*.api_key",
  "OPENAI_API_KEY",
  "JEV_API_KEY",
  "password",
  "*.password",
  "cursor_secret",
];

export function createLogger(level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
    },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const log = createLogger();

export function withRequestId(requestId: string) {
  return log.child({ requestId });
}

export function newRequestId(): string {
  return crypto.randomUUID();
}
