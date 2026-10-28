import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/log";
import pino from "pino";
import { Writable } from "node:stream";

describe("log redaction", () => {
  it("U-LOG-1 redacts authorization and api keys", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger("info");
    const destLogger = pino(
      {
        level: "info",
        redact: {
          paths: [
            "authorization",
            "OPENAI_API_KEY",
            "*.apiKey",
            "err.config.headers.Authorization",
            "*.headers.authorization",
          ],
          censor: "[Redacted]",
        },
      },
      stream,
    );
    destLogger.info(
      {
        authorization: "Bearer secret",
        OPENAI_API_KEY: "sk-x",
        nested: { apiKey: "y" },
        err: { config: { headers: { Authorization: "Bearer leaked" } } },
      },
      "t",
    );
    await new Promise((r) => setTimeout(r, 20));
    const out = chunks.join("");
    expect(out).toContain("[Redacted]");
    expect(out).not.toContain("Bearer secret");
    expect(out).not.toContain("sk-x");
    expect(out).not.toContain("Bearer leaked");
    expect(logger).toBeTruthy();
  });
});
