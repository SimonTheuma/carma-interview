import { describe, expect, it } from "vitest";
import { authorizeUpload, extractBearerToken } from "@/lib/upload/auth";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { checkRateLimit, resetRateLimitForTests } from "@/lib/upload/rate-limit";

describe("upload auth", () => {
  it("accepts with no token when upload enabled", () => {
    resetConfigCache();
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
      UPLOAD_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    expect(authorizeUpload(cfg, null).ok).toBe(true);
  });

  it("accepts with leftover token headers when upload enabled", () => {
    resetConfigCache();
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
      UPLOAD_ENABLED: "true",
    } as NodeJS.ProcessEnv);
    expect(authorizeUpload(cfg, "x".repeat(40)).ok).toBe(true);
  });

  it("reports upload_disabled when kill switch is off", () => {
    resetConfigCache();
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
      UPLOAD_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    const r = authorizeUpload(cfg, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("upload_disabled");
  });

  it("extracts bearer and x-upload-token", () => {
    const a = new Request("http://x", { headers: { authorization: "Bearer abc" } });
    expect(extractBearerToken(a)).toBe("abc");
    const b = new Request("http://x", { headers: { "x-upload-token": "xyz" } });
    expect(extractBearerToken(b)).toBe("xyz");
  });

  it("rate limits after N uploads", () => {
    resetRateLimitForTests();
    const fp = "test-fp";
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit(fp, 10)).toBeNull();
    }
    expect(checkRateLimit(fp, 10)).toBeGreaterThan(0);
  });
});
