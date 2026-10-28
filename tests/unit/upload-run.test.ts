import { describe, expect, it, beforeEach } from "vitest";
import { runUpload } from "@/lib/upload/run";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { resetRateLimitForTests } from "@/lib/upload/rate-limit";
import { releaseUpload } from "@/lib/upload/semaphore";

describe("upload run (gate layer, no DB)", () => {
  beforeEach(() => {
    resetConfigCache();
    resetRateLimitForTests();
    releaseUpload();
  });

  it("rejects upload_disabled when kill switch is off", async () => {
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
      UPLOAD_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    const req = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
      body: "[]",
    });
    const res = await runUpload(req, cfg);
    expect(res.status).toBe(503);
    expect((res.body as { reason: string }).reason).toBe("upload_disabled");
  });

  it("rejects file_too_large on Content-Length", async () => {
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
      UPLOAD_MAX_BYTES: "100",
    } as NodeJS.ProcessEnv);
    const req = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "9999",
      },
      body: "[]",
    });
    const res = await runUpload(req, cfg);
    expect(res.status).toBe(413);
    expect((res.body as { reason: string }).reason).toBe("file_too_large");
  });

  it("rejects not_an_array", async () => {
    const cfg = loadConfig({
      NODE_ENV: "test",
      ROLE: "web",
      DB_PASSWORD: "x",
    } as NodeJS.ProcessEnv);
    const req = new Request("http://localhost/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: '{"no":"array"}',
    });
    const res = await runUpload(req, cfg);
    expect(res.status).toBe(400);
    expect((res.body as { reason: string }).reason).toBe("not_an_array");
  });
});
