import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getConfig();
  const pool = getWebPool(config.db);
  try {
    const res = await pool.query<{ snapshot: Record<string, unknown> }>(
      `SELECT status_snapshot() AS snapshot`,
    );
    const s = res.rows[0]?.snapshot ?? {};
    const openJobs = Number(s.open_jobs ?? 0);
    const dead = Number(s.dead_jobs ?? 0);
    const qOpen = Number(s.quarantine_open ?? 0);

    let headline: "Complete" | "Processing" | "Complete with gaps" = "Complete";
    if (openJobs > 0) headline = "Processing";
    else if (dead > 0 || qOpen > 0) headline = "Complete with gaps";

    return Response.json({
      headline,
      complete: openJobs === 0,
      gaps: { dead, quarantine_open: qOpen },
      articles_total: Number(s.articles_total ?? 0),
      jobs: s.jobs ?? [],
      oldest_actionable_job_age_s:
        s.oldest_actionable_job_age_s != null ? Number(s.oldest_actionable_job_age_s) : null,
      budget: s.budget ?? [],
      flags: s.flags ?? [],
      quarantine: {
        open: qOpen,
        oldest: s.quarantine_oldest ?? null,
      },
      watermark: {
        published_at: s.watermark_published_at ?? null,
        ingested_at: s.watermark_ingested_at ?? null,
      },
      upload: {
        enabled: config.upload.enabled,
        ingest_pool_ok: Boolean(config.ingestPool.password),
      },
      freshness: { note: "No live batches yet" },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "status failed" },
      { status: 500 },
    );
  }
}
