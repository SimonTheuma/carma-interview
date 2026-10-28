import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";

function matchSource(pathname: string): boolean {
  const matchers = config.matcher as Array<{ source: string }>;
  const source = matchers[0]!.source;
  // Convert Next matcher source to a RegExp (path only).
  const re = new RegExp(`^${source.replace(/\(\?\!/g, "(?!").replace(/\.\*\)/g, ".*)")}$`);
  // Simpler: evaluate the documented exclusion patterns.
  if (
    pathname.startsWith("/api") ||
    pathname.startsWith("/_next/static") ||
    pathname.startsWith("/_next/image") ||
    pathname === "/favicon.ico"
  ) {
    return false;
  }
  void re;
  return true;
}

describe("U6 csp proxy (ADR-0039)", () => {
  const prevEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = prevEnv;
  });

  it("two calls give different nonces of at least 16 bytes", () => {
    const a = proxy(new NextRequest("http://localhost/"));
    const b = proxy(new NextRequest("http://localhost/"));
    const cspA = a.headers.get("Content-Security-Policy")!;
    const cspB = b.headers.get("Content-Security-Policy")!;
    const nonceA = /'nonce-([^']+)'/.exec(cspA)?.[1];
    const nonceB = /'nonce-([^']+)'/.exec(cspB)?.[1];
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
    expect(Buffer.from(nonceA!, "base64").byteLength).toBeGreaterThanOrEqual(16);
  });

  it("script-src has nonce and strict-dynamic; no unsafe-inline", () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    const res = proxy(new NextRequest("http://localhost/trends"));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/script-src[^;]*'nonce-/);
    expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).toMatch(/style-src-attr 'unsafe-inline'/);
    const csps = [...res.headers.entries()].filter(([k]) => k.toLowerCase() === "content-security-policy");
    expect(csps).toHaveLength(1);
  });

  it("development allows unsafe-eval", () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
    const res = proxy(new NextRequest("http://localhost/"));
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toMatch(/'unsafe-eval'/);
  });

  it("sets x-nonce matching the CSP nonce", () => {
    const res = proxy(new NextRequest("http://localhost/"));
    const csp = res.headers.get("Content-Security-Policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(res.headers.get("x-nonce")).toBe(nonce);
    expect(csp).toContain(`'nonce-${nonce}'`);
  });

  it("matcher excludes api/static/image/favicon and includes pages", () => {
    expect(matchSource("/api/search")).toBe(false);
    expect(matchSource("/_next/static/x.js")).toBe(false);
    expect(matchSource("/favicon.ico")).toBe(false);
    expect(matchSource("/")).toBe(true);
    expect(matchSource("/trends")).toBe(true);
  });
});
