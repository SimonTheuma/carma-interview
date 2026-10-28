import { monitorEventLoopDelay } from "node:perf_hooks";
import { gauge } from "../metrics";

const lagGauge = gauge("mss_event_loop_lag_seconds", "Event loop lag (mean over sample)");

let started = false;

export function startEventLoopLagSampler(intervalMs = 5000): void {
  if (started) return;
  started = true;
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const t = setInterval(() => {
    lagGauge.set({}, h.mean / 1e9);
    h.reset();
  }, intervalMs);
  t.unref?.();
}
