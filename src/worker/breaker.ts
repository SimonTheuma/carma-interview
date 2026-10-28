export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
  state: BreakerState = "closed";
  failures = 0;
  openedAt = 0;
  /** In half_open, only one probe may be in flight. */
  probeInFlight = false;

  constructor(
    readonly name: string,
    readonly threshold = 5,
    readonly coolDownMs = 30_000,
  ) {}

  canRequest(now: number): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (now - this.openedAt >= this.coolDownMs) {
        this.state = "half_open";
        this.probeInFlight = false;
        return true;
      }
      return false;
    }
    // half_open: allow a single probe
    return !this.probeInFlight;
  }

  /** Mark that a half-open probe has been claimed / started. */
  markProbeStarted(): void {
    if (this.state === "half_open") this.probeInFlight = true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
    this.probeInFlight = false;
  }

  onFailure(now: number): void {
    this.failures++;
    this.probeInFlight = false;
    if (this.state === "half_open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = now;
      this.failures = 0;
    }
  }

  snapshot(): string {
    return JSON.stringify({
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt,
      probeInFlight: this.probeInFlight,
    });
  }
}
