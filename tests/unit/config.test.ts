import { describe, expect, it, beforeEach } from "vitest";
import { loadConfig, resetConfigCache } from "@/lib/config";

function env(partial: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", ...partial } as NodeJS.ProcessEnv;
}

describe("config", () => {
  beforeEach(() => {
    resetConfigCache();
  });

  it("U-CFG-1 defaults to mock when keys absent", () => {
    const cfg = loadConfig(env({ ENRICHMENT_MODE: "auto", ROLE: "worker", DB_PASSWORD: "x" }));
    expect(cfg.jev.mode).toBe("mock");
    expect(cfg.openai.mode).toBe("mock");
  });

  it("U-CFG-2 requires OPENAI_MODEL when key set", () => {
    expect(() =>
      loadConfig(env({ ENRICHMENT_MODE: "auto", OPENAI_API_KEY: "sk-test", ROLE: "worker", DB_PASSWORD: "x" })),
    ).toThrow(/OPENAI_MODEL is required/);
  });

  it("U-CFG-3 real mode fails without key", () => {
    expect(() => loadConfig(env({ ENRICHMENT_MODE: "real", ROLE: "worker", DB_PASSWORD: "x" }))).toThrow(
      /API key is required/,
    );
  });

  it("U-CFG-4 mock mode ignores missing keys", () => {
    const cfg = loadConfig(env({ ENRICHMENT_MODE: "mock", ROLE: "worker", DB_PASSWORD: "x" }));
    expect(cfg.jev.mode).toBe("mock");
  });

  it("U-CFG-5 requires prices in real openai mode", () => {
    expect(() =>
      loadConfig(
        env({
          ENRICHMENT_MODE: "auto",
          OPENAI_API_KEY: "sk-test",
          OPENAI_MODEL: "gpt-4o-mini",
          ROLE: "worker",
          DB_PASSWORD: "x",
        }),
      ),
    ).toThrow(/OPENAI_PRICE/);
  });

  it("U-CFG-6 accepts complete real openai config", () => {
    const cfg = loadConfig(
      env({
        ENRICHMENT_MODE: "auto",
        OPENAI_API_KEY: "sk-test",
        OPENAI_MODEL: "gpt-4o-mini",
        OPENAI_PRICE_IN_PER_MTOK: "0.15",
        OPENAI_PRICE_OUT_PER_MTOK: "0.6",
        ROLE: "worker",
        DB_PASSWORD: "x",
      }),
    );
    expect(cfg.openai.mode).toBe("real");
    expect(cfg.openai.model).toBe("gpt-4o-mini");
  });

  it("rejects CLAIM_VISIBILITY_SECONDS shorter than CALL_TIMEOUT_MS", () => {
    expect(() =>
      loadConfig(
        env({
          ROLE: "worker",
          DB_PASSWORD: "x",
          CALL_TIMEOUT_MS: "60000",
          CLAIM_VISIBILITY_SECONDS: "30",
        }),
      ),
    ).toThrow(/CLAIM_VISIBILITY_SECONDS/);
  });

  it("defaults translate budget and concurrency (ADR-0029)", () => {
    const cfg = loadConfig(env({ ROLE: "worker", DB_PASSWORD: "x" }));
    expect(cfg.budget.openaiDaily).toBe(10);
    expect(cfg.budget.translateDaily).toBe(3);
    expect(cfg.workerConcurrency.translate).toBe(2);
    expect(cfg.rpm.translate).toBe(60);
    expect(cfg.translation.enabled).toBe(true);
    expect(cfg.translation.maxChunks).toBe(20);
    expect(cfg.translation.ratioCjk).toEqual({ min: 0.15, max: Infinity });
    expect(cfg.translation.ratioOther).toEqual({ min: 0.3, max: 3.0 });
  });

  it("rejects bad TRANSLATE_RATIO_CJK with the variable name", () => {
    expect(() =>
      loadConfig(env({ ROLE: "worker", DB_PASSWORD: "x", TRANSLATE_RATIO_CJK: "4,0.1" })),
    ).toThrow(/TRANSLATE_RATIO_CJK/);
  });
});
