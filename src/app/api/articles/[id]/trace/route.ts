import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const config = getConfig();
  const pool = getWebPool(config.db);
  const article = await pool.query(`SELECT * FROM articles WHERE id = $1`, [id]);
  if (!article.rows[0]) return Response.json({ error: "not_found" }, { status: 404 });
  const version = Number(article.rows[0].version ?? 1);
  const [jobs, enrichments, derived, transforms, events, versions, translations] =
    await Promise.all([
      pool.query(
        `SELECT * FROM enrichment_jobs WHERE article_id = $1 AND article_version = $2`,
        [id, version],
      ),
      pool.query(
        `SELECT * FROM enrichments WHERE article_id = $1 AND article_version = $2`,
        [id, version],
      ),
      pool.query(`SELECT * FROM derived_values WHERE article_id = $1`, [id]),
      pool.query(`SELECT * FROM ingest_transformations WHERE article_id = $1`, [id]),
      pool.query(`SELECT * FROM ingest_events WHERE article_id = $1`, [id]),
      pool.query(`SELECT * FROM article_versions WHERE article_id = $1 ORDER BY version`, [id]),
      pool.query(
        `SELECT id, article_id, article_version, target_lang, source_lang, detected_lang,
                headline_en, body_en, enrichment_id, chunk_count, flags, created_at, superseded_at
           FROM article_translations WHERE article_id = $1 ORDER BY created_at`,
        [id],
      ),
    ]);
  return Response.json({
    article: article.rows[0],
    jobs: jobs.rows,
    enrichments: enrichments.rows,
    derived: derived.rows,
    transforms: transforms.rows,
    events: events.rows,
    versions: versions.rows,
    translations: translations.rows,
  });
}
