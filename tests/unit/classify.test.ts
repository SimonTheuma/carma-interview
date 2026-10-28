import { describe, expect, it } from "vitest";
import { InvalidOutputError } from "@/lib/enrich/validate-output";
import { classifyProviderError, formatLastError } from "@/worker/classify";

describe("classifyProviderError", () => {
  it("classifies InvalidOutputError as invalid_output", () => {
    expect(classifyProviderError(new InvalidOutputError("schema"))).toBe("invalid_output");
  });

  it("does not treat a DB schema message as invalid_output", () => {
    expect(classifyProviderError(new Error('relation "public.schema" does not exist'))).toBe(
      "transient",
    );
  });

  it("maps HTTP 500 to transient and 401 to permanent", () => {
    const e500 = new Error("boom");
    (e500 as Error & { status: number }).status = 500;
    expect(classifyProviderError(e500)).toBe("transient");
    const e401 = new Error("nope");
    (e401 as Error & { status: number }).status = 401;
    expect(classifyProviderError(e401)).toBe("permanent");
  });
});

describe("formatLastError", () => {
  it("uses reason for InvalidOutputError without raw payload", () => {
    expect(formatLastError(new InvalidOutputError("unknown_topic"))).toBe(
      "invalid_output:unknown_topic",
    );
  });

  it("prefers status code over long message body", () => {
    const e = new Error(`HTTP fail ${"x".repeat(400)}`);
    (e as Error & { status: number }).status = 503;
    expect(formatLastError(e)).toBe("Error:status=503");
  });
});
