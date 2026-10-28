import { getConfig } from "@/lib/config";
import { getWebPool, query } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = getConfig();
    const pool = getWebPool(config.db);
    await query(pool, "SELECT 1");
    const mig = await query<{ n: string }>(
      pool,
      "SELECT count(*)::text AS n FROM schema_migrations",
    );
    if (!mig.rows[0] || Number(mig.rows[0].n) < 1) {
      return Response.json({ ok: false, reason: "migrations_pending" }, { status: 503 });
    }
    const tr = await query<{ reg: string | null }>(
      pool,
      `SELECT to_regclass('public.article_translations')::text AS reg`,
    );
    if (!tr.rows[0]?.reg) {
      return Response.json({ ok: false, reason: "article_translations_missing" }, { status: 503 });
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, reason: "db_unreachable" }, { status: 503 });
  }
}
