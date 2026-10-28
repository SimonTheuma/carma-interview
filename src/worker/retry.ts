import type { Clock } from "../lib/clock";
import type { FailureClass } from "./classify";

export function maxAttemptsFor(cls: FailureClass, configuredMax: number): number {
  if (cls === "permanent") return 1;
  if (cls === "invalid_output") return 2;
  return configuredMax;
}

export function nextDelayMs(attempt: number, clock: Clock): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor((clock.now().getTime() % 500) * (base / 500));
  return base + (jitter % Math.max(1, Math.floor(base * 0.2)));
}
