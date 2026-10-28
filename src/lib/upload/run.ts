import { createHash } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "../config";
import { loadArticles, type LoadResult } from "../ingest/ingest";
import { createIngestPool } from "../db/pool";
import { counter, histogram, gauge } from "../metrics";
import { log } from "../log";
import { authorizeUpload } from "./auth";
import { gateRequest } from "./gate";
import { checkRateLimit } from "./rate-limit";
import { tryAcquireUpload, releaseUpload, uploadInFlight } from "./semaphore";

const uploadRequests = counter("mss_upload_requests_total", "Upload requests by outcome");
const uploadRejected = counter("mss_upload_rejected_total", "Upload rejections by reason");
const uploadItems = counter("mss_upload_items_total", "Upload items by outcome");
const uploadVersions = counter("mss_upload_versions_total", "Upload version outcomes");
const uploadMismatch = counter(
  "mss_upload_reconcile_mismatch_total",
  "Upload reconcile mismatches",
);
const uploadBytes = histogram("mss_upload_bytes", "Upload body size", [
  1e4, 1e5, 5e5, 1e6, 2.5e6, 5e6,
]);
const uploadItemsHist = histogram("mss_upload_items", "Upload item counts", [
  1, 10, 50, 100, 250, 500, 1000,
]);
const uploadDuration = histogram(
  "mss_upload_duration_seconds",
  "Upload request duration",
  [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
);
const uploadInFlightGauge = gauge("mss_upload_in_flight", "Uploads currently in flight");

export type UploadResponseBody = {
  received: number;
  admitted: number;
  duplicate: number;
  quarantined: number;
  versions: number;
  batchId: string;
  reconciled: boolean;
  items: LoadResult["items"];
  displayName?: string;
  error?: string;
  reason?: string;
  retryAfter?: number;
};

export type UploadHttpResult = {
  status: number;
  body: UploadResponseBody | { error: string; reason: string; retryAfter?: number; batchId?: string };
  headers?: Record<string, string>;
};

function reject(
  reason: string,
  status: number,
  message: string,
  extra?: { retryAfter?: number },
): UploadHttpResult {
  uploadRejected.inc({ reason });
  uploadRequests.inc({ outcome: "rejected", status_class: String(Math.floor(status / 100) * 100) });
  const headers: Record<string, string> = {};
  if (extra?.retryAfter != null) headers["Retry-After"] = String(extra.retryAfter);
  return {
    status,
    body: {
      error: message,
      reason,
      ...(extra?.retryAfter != null ? { retryAfter: extra.retryAfter } : {}),
    },
    headers,
  };
}

function isConnectionError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { code?: string; message?: string };
  if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET" || err.code === "57P01") return true;
  if (err.code === "57P03" || err.code === "08006" || err.code === "08003" || err.code === "28P01")
    return true;
  const msg = (err.message ?? "").toLowerCase();
  return msg.includes("connection") || msg.includes("timeout") || msg.includes("terminat");
}

export async function runUpload(
  request: Request,
  config: AppConfig,
  opts?: { pool?: pg.Pool },
): Promise<UploadHttpResult> {
  const started = Date.now();
  const auth = authorizeUpload(config);
  if (!auth.ok) {
    return reject(auth.reason, auth.status, "Upload is disabled");
  }

  const retryAfter = checkRateLimit("upload", config.upload.rateLimitPerHour);
  if (retryAfter != null) {
    return reject("rate_limited", 429, `Too many requests, retry after ${Math.ceil(retryAfter / 60)} min`, {
      retryAfter,
    });
  }

  if (!tryAcquireUpload()) {
    return reject("upload_busy", 429, "Another upload is running, retry in a few seconds", {
      retryAfter: 5,
    });
  }
  uploadInFlightGauge.set({}, 1);

  let ownedPool: pg.Pool | undefined;
  try {
    const gated = await gateRequest(request, config);
    if (!gated.ok) {
      return reject(gated.reason, gated.status, gated.message);
    }

    uploadBytes.observe({}, gated.bytes);
    uploadItemsHist.observe({}, gated.items.length);

    const deadline = started + config.upload.deadlineMs;
    const pool =
      opts?.pool ??
      (() => {
        ownedPool = createIngestPool(config, "web-ingest");
        return ownedPool;
      })();

    const remaining = () => deadline - Date.now();
    if (remaining() <= 0) {
      return reject("deadline_exceeded", 504, "The upload did not finish");
    }

    let result: LoadResult;
    try {
      const ingestPromise = loadArticles(gated.items, "backfill", pool, {
        ...config,
        db: {
          ...config.db,
          user: "app_ingest",
          password: config.ingestPool.password ?? config.db.password,
        },
      });
      result = await Promise.race([
        ingestPromise,
        new Promise<never>((_, rej) => {
          const t = setTimeout(
            () => rej(Object.assign(new Error("deadline"), { code: "DEADLINE" })),
            Math.max(1, remaining()),
          );
          t.unref?.();
        }),
      ]);
    } catch (e) {
      if ((e as { code?: string })?.code === "DEADLINE") {
        return {
          status: 504,
          body: {
            error: "The upload did not finish. Some articles may have been stored.",
            reason: "deadline_exceeded",
          },
        };
      }
      if (isConnectionError(e)) {
        return reject("db_unavailable", 503, "Database unavailable", { retryAfter: 10 });
      }
      log.error({ err: e }, "upload ingest failed");
      return reject("internal_error", 500, "The upload did not finish. Some articles may have been stored.");
    }

    for (const item of result.items) {
      uploadItems.inc({ outcome: item.outcome });
      if (item.reasonCodes.includes("new_version")) {
        uploadVersions.inc({ outcome: "new_version" });
      } else if (item.outcome === "duplicate") {
        uploadVersions.inc({ outcome: "unchanged" });
      }
    }

    if (!result.reconciled) {
      uploadMismatch.inc();
      uploadRequests.inc({ outcome: "error", status_class: "500" });
      return {
        status: 500,
        body: {
          ...result,
          error: "Reconcile mismatch",
          reason: "internal_error",
          ...(gated.displayName ? { displayName: gated.displayName } : {}),
        },
      };
    }

    uploadRequests.inc({ outcome: "ok", status_class: "200" });
    uploadDuration.observe({}, (Date.now() - started) / 1000);
    log.info(
      {
        event: "upload",
        batch_id: result.batchId,
        outcome: "ok",
        status: 200,
        bytes: gated.bytes,
        items: result.received,
        admitted: result.admitted,
        duplicate: result.duplicate,
        quarantined: result.quarantined,
        new_versions: result.versions,
        reconciled: result.reconciled,
        duration_ms: Date.now() - started,
        file_sha256: createHash("sha256")
          .update(JSON.stringify(gated.items))
          .digest("hex"),
      },
      "upload complete",
    );

    return {
      status: 200,
      body: {
        received: result.received,
        admitted: result.admitted,
        duplicate: result.duplicate,
        quarantined: result.quarantined,
        versions: result.versions,
        batchId: result.batchId,
        reconciled: result.reconciled,
        items: result.items,
        ...(gated.displayName ? { displayName: gated.displayName } : {}),
      },
    };
  } finally {
    releaseUpload();
    uploadInFlightGauge.set({}, uploadInFlight() ? 1 : 0);
    if (ownedPool) await ownedPool.end().catch(() => undefined);
  }
}
