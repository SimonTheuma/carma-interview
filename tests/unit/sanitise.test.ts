import { describe, expect, it } from "vitest";
import { reduceMarkup } from "@/lib/sanitise/reduce";

describe("sanitiser", () => {
  it("U-SAN-1 strips script and keeps surrounding text", () => {
    const r = reduceMarkup(
      `Hello <script>document.location='http://evil.com'</script> world`,
    );
    expect(r.text).toContain("Hello");
    expect(r.text).toContain("world");
    expect(r.text).not.toContain("document.location");
    expect(r.transformations.some((t) => t.kind === "markup_removed")).toBe(true);
  });

  it("U-SAN-6 headline XSS becomes text", () => {
    const r = reduceMarkup(`<img src=x onerror=alert('XSS')>Breaking: Major Data Breach Reported`);
    expect(r.text).toBe("Breaking: Major Data Breach Reported");
  });

  it("U-SAN keeps vigorous text without tags", () => {
    const r = reduceMarkup("The firm vigorously denied the allegations.");
    expect(r.text).toContain("vigorously");
  });
});
