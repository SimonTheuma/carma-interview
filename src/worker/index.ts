import http from "node:http";
import { loadConfig } from "../lib/config";
import { createPool } from "../lib/db/pool";
import { log } from "../lib/log";
import { renderPrometheus, gauge } from "../lib/metrics";
import { systemClock } from "../lib/clock";

const heartbeatGauge = gauge("mss_worker_heartbeat_unixtime", "Last worker heartbeat unix time");

async function main(): Promise<void> {
  process.env.ROLE = "worker";
  const config = loadConfig();
  log.info({ jevMode: config.jev.mode }, `jev: ${config.jev.mode}`);
  log.info({ openaiMode: config.openai.mode }, `openai: ${config.openai.mode}`);

  const poolMax =
    config.workerConcurrency.jev +
    config.workerConcurrency.openai +
    config.workerConcurrency.translate +
    2;
  const pool = createPool(config.db, "worker", poolMax);
  log.info(
    { translateMode: config.openai.mode, poolMax },
    `translation: ${config.openai.mode}`,
  );
  let stopping = false;

  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, stopping }));
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(renderPrometheus());
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(9101, "0.0.0.0");

  async function beat(): Promise<void> {
    const now = systemClock.now();
    heartbeatGauge.set({}, Math.floor(now.getTime() / 1000));
    try {
      await pool.query("SELECT worker_set_flag('worker.heartbeat', $1)", [now.toISOString()]);
    } catch (err) {
      log.warn({ err }, "heartbeat write failed");
    }
  }

  await beat();
  const beatTimer = setInterval(() => {
    void beat();
  }, 10_000);

  const { refreshJobGauges } = await import("./metrics-refresh");
  const metricsTimer = setInterval(() => {
    void refreshJobGauges(pool).catch((err) => log.warn({ err }, "metrics refresh failed"));
  }, 60_000);
  void refreshJobGauges(pool).catch(() => undefined);

  process.on("SIGTERM", () => {
    log.info("SIGTERM received; stopping claims");
    stopping = true;
  });

  const { runWorkerLoop } = await import("./loop");
  await runWorkerLoop({
    pool,
    config,
    clock: systemClock,
    shouldStop: () => stopping,
  });

  clearInterval(beatTimer);
  clearInterval(metricsTimer);
  server.close();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, "worker failed");
  process.exit(1);
});
