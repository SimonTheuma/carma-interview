import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ batchId: string }> },
) {
  const { batchId } = await ctx.params;
  if (!UUID_RE.test(batchId)) {
    return Response.json({ error: "Invalid batch id", reason: "invalid_batch_id" }, { status: 400 });
  }

  const config = getConfig();
  const pool = getWebPool(config.db);
  try {
    const res = await pool.query<{
      item_position: number;
      outcome: string;
      reason_codes: string[];
      article_id: string | null;
      article_version: number | null;
      sentiment_state: string | null;
      summary_topics_state: string | null;
      quarantine_status: string | null;
    }>(`SELECT * FROM upload_batch_status($1::uuid)`, [batchId]);

    if (res.rows.length === 0) {
      return Response.json({ error: "Unknown batch", reason: "not_found" }, { status: 404 });
    }

    const items = res.rows.map((r) => ({
      position: r.item_position,
      outcome: r.outcome,
      reasonCodes: r.reason_codes ?? [],
      articleId: r.article_id,
      articleVersion: r.article_version,
      sentimentState: r.sentiment_state,
      summaryTopicsState: r.summary_topics_state,
      quarantineStatus: r.quarantine_status,
    }));

    const admitted = items.filter((i) => i.outcome === "admitted").length;
    const duplicate = items.filter((i) => i.outcome === "duplicate").length;
    const quarantined = items.filter((i) => i.outcome === "quarantined").length;
    const versions = items.filter((i) => i.reasonCodes.includes("new_version")).length;

    const openStates = new Set([
      "queued",
      "running",
      "failed_retryable",
      "deferred_budget",
    ]);
    let enriched = 0;
    let waiting = 0;
    let deferred = 0;
    let failed = 0;
    for (const i of items) {
      if (i.outcome !== "admitted") continue;
      const states = [i.sentimentState, i.summaryTopicsState].filter(Boolean) as string[];
      if (states.every((s) => s === "succeeded" || s === "skipped_no_content")) enriched++;
      else if (states.some((s) => s === "deferred_budget")) deferred++;
      else if (states.some((s) => s === "dead")) failed++;
      else if (states.some((s) => openStates.has(s))) waiting++;
    }

    return Response.json({
      batchId,
      received: items.length,
      admitted,
      duplicate,
      quarantined,
      versions,
      reconciled: items.length === admitted + duplicate + quarantined,
      enrichment: { enriched, waiting, deferred, failed, admitted },
      items,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "status failed", reason: "internal_error" },
      { status: 500 },
    );
  }
}
