import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("U7 next.config headers (ADR-0039)", () => {
  it("keeps nosniff / Referrer-Policy / X-Frame-Options and has no CSP", async () => {
    const headersFn = nextConfig.headers;
    expect(headersFn).toBeTypeOf("function");
    const entries = await headersFn!();
    expect(entries).toHaveLength(1);
    const headers = entries[0]!.headers;
    const byKey = Object.fromEntries(headers.map((h) => [h.key, h.value]));
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("no-referrer");
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["Content-Security-Policy"]).toBeUndefined();
    expect(headers.some((h) => h.key.toLowerCase() === "content-security-policy")).toBe(false);
  });
});
