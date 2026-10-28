import { describe, expect, it } from "vitest";
import { normaliseText, buildSearchText } from "@/lib/normalise";

describe("normaliser", () => {
  it("U-NORM case fold", () => {
    expect(normaliseText("Oil Prices")).toBe("oil prices");
  });

  it("U-NORM Arabic alef unify", () => {
    expect(normaliseText("أحمد")).toContain("ا");
  });

  it("U-NORM buildSearchText coalesces", () => {
    expect(buildSearchText(null, "Body")).toBe("body");
    expect(buildSearchText("Head", null)).toBe("head");
  });
});
