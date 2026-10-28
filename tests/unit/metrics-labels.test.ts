import { describe, expect, it } from "vitest";
import { METRIC_ALLOWED_LABEL_KEYS, counter } from "@/lib/metrics";

const CATALOGUE_LABELS = [
  "provider",
  "part",
  "outcome",
  "state",
  "method",
  "code",
  "origin",
  "reason",
  "route",
  "status_class",
  "pool",
  "query",
  "kind",
  "phase",
  "batch_kind",
  "script",
  "view",
];

describe("metric label allow-list", () => {
  it("allows every catalogued label key", () => {
    for (const k of CATALOGUE_LABELS) {
      expect(METRIC_ALLOWED_LABEL_KEYS.has(k)).toBe(true);
    }
  });

  it("does not throw when using catalogue labels", () => {
    const c = counter("mss_test_label_catalogue", "test");
    expect(() => c.inc({ reason: "unauthorized", route: "uploads", status_class: "400" })).not.toThrow();
  });
});
