import { getConfig } from "@/lib/config";
import { getWebIngestPool } from "@/lib/db/pool";
import { runUpload } from "@/lib/upload/run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = getConfig();
  const pool =
    config.upload.enabled && config.ingestPool.password
      ? getWebIngestPool(config)
      : undefined;
  const result = await runUpload(request, config, pool ? { pool } : undefined);
  return Response.json(result.body, {
    status: result.status,
    headers: {
      "X-Content-Type-Options": "nosniff",
      ...(result.headers ?? {}),
    },
  });
}
