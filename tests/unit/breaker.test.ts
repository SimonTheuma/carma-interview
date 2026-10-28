import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "@/worker/breaker";

describe("CircuitBreaker", () => {
  it("opens at threshold and cools down to half_open", () => {
    const b = new CircuitBreaker("jev", 3, 1000);
    const t0 = 1_000_000;
    expect(b.canRequest(t0)).toBe(true);
    b.onFailure(t0);
    b.onFailure(t0 + 1);
    b.onFailure(t0 + 2);
    expect(b.state).toBe("open");
    expect(b.canRequest(t0 + 500)).toBe(false);
    // openedAt is t0+2; cool-down is 1000ms
    expect(b.canRequest(t0 + 2 + 1000)).toBe(true);
    expect(b.state).toBe("half_open");
  });

  it("half_open allows only one probe until success or failure", () => {
    const b = new CircuitBreaker("jev", 1, 10);
    b.onFailure(100);
    expect(b.state).toBe("open");
    expect(b.canRequest(110)).toBe(true);
    expect(b.state).toBe("half_open");
    b.markProbeStarted();
    expect(b.canRequest(111)).toBe(false);
    b.onSuccess();
    expect(b.state).toBe("closed");
    expect(b.canRequest(112)).toBe(true);
  });

  it("half_open probe failure reopens", () => {
    const b = new CircuitBreaker("openai", 1, 10);
    b.onFailure(100);
    expect(b.canRequest(110)).toBe(true);
    b.markProbeStarted();
    b.onFailure(111);
    expect(b.state).toBe("open");
    expect(b.canRequest(112)).toBe(false);
  });
});
