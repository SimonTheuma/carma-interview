import { describe, expect, it } from "vitest";
import { repairText } from "@/lib/ingest/ingest";

describe("repairText", () => {
  it("strips NULs", () => {
    expect(repairText("a\u0000b")).toBe("ab");
  });

  it("drops lone surrogates but keeps valid pairs", () => {
    const pair = "\uD83D\uDE00"; // 😀
    expect(repairText(`x${pair}y`)).toBe(`x${pair}y`);
    expect(repairText("a\uD800b")).toBe("ab");
    expect(repairText("a\uDCFFb")).toBe("ab");
  });

  it("returns null for null", () => {
    expect(repairText(null)).toBeNull();
  });
});
