import { describe, expect, it, beforeEach } from "vitest";
import { POST } from "@/app/api/telemetry/translation-view/route";
import { renderPrometheus } from "@/lib/metrics";

describe("translation-view beacon", () => {
  beforeEach(() => {
    // metrics are process-global; just exercise the route
  });

  async function post(view: string) {
    return POST(
      new Request("http://localhost/api/telemetry/translation-view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ view }),
      }),
    );
  }

  it("accepts original_shown and original_hidden", async () => {
    expect((await post("original_shown")).status).toBe(204);
    expect((await post("original_hidden")).status).toBe(204);
    const text = renderPrometheus();
    expect(text).toMatch(/mss_translation_view_total/);
  });

  it("keeps legacy translated/original for one release", async () => {
    expect((await post("translated")).status).toBe(204);
    expect((await post("original")).status).toBe(204);
  });

  it("drops unknown views", async () => {
    expect((await post("nope")).status).toBe(204);
    const text = renderPrometheus();
    expect(text).toMatch(/mss_ui_event_dropped_total/);
  });
});
