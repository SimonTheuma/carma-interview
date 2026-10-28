import { describe, expect, it } from "vitest";
import { decodeStrictUtf8, parseArticlesJson, sanitizeDisplayName } from "@/lib/upload/gate";
import { loadConfig } from "@/lib/config";

const config = loadConfig({
  NODE_ENV: "test",
  ROLE: "web",
  DB_PASSWORD: "x",
  UPLOAD_MAX_ITEMS: "3",
  UPLOAD_MAX_DEPTH: "3",
} as NodeJS.ProcessEnv);

describe("upload gate", () => {
  it("rejects non-array JSON", () => {
    const r = parseArticlesJson('{"a":1}', config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_an_array");
  });

  it("rejects too many items", () => {
    const r = parseArticlesJson(JSON.stringify([{}, {}, {}, {}]), config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_many_items");
  });

  it("rejects nesting that is too deep", () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const r = parseArticlesJson(JSON.stringify([deep]), config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too_deep");
  });

  it("accepts a BOM-prefixed UTF-8 array", () => {
    const text = "\uFEFF[]";
    const bytes = new TextEncoder().encode(text);
    // BOM as UTF-8 bytes
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("[]")]);
    const decoded = decodeStrictUtf8(withBom);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      const r = parseArticlesJson(decoded.text, config);
      expect(r.ok).toBe(true);
    }
    void bytes;
  });

  it("rejects invalid UTF-8", () => {
    const bad = new Uint8Array([0xff, 0xfe, 0x00]);
    const r = decodeStrictUtf8(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_encoding");
  });

  it("sanitises display names", () => {
    expect(sanitizeDisplayName("../x\u0000.json")?.includes("\u0000")).toBeFalsy();
    expect(sanitizeDisplayName("a".repeat(200))!.length).toBeLessThanOrEqual(100);
  });
});
