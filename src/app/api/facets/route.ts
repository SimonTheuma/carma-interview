import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

let cache: { at: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.at < 30_000) {
    return Response.json(cache.body);
  }
  const config = getConfig();
  const pool = getWebPool(config.db);
  const sources = await pool.query(
    `SELECT source AS value, count(*)::int AS n FROM articles GROUP BY source ORDER BY n DESC, source`,
  );
  const languages = await pool.query(
    `SELECT language AS value, count(*)::int AS n FROM articles GROUP BY language ORDER BY n DESC`,
  );
  const sentiments = await pool.query(
    `SELECT value, count(*)::int AS n FROM derived_values WHERE field='sentiment' AND is_current GROUP BY value ORDER BY n DESC`,
  );
  const topics = await pool.query(
    `SELECT value, count(*)::int AS n FROM derived_values WHERE field='topic' AND is_current GROUP BY value ORDER BY n DESC`,
  );
  const body = {
    sources: sources.rows,
    languages: languages.rows,
    sentiments: sentiments.rows,
    topics: topics.rows,
  };
  cache = { at: Date.now(), body };
  return Response.json(body);
}
