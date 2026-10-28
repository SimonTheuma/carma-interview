import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getConfig();
  return Response.json({
    maxBytes: config.upload.maxBytes,
    maxItems: config.upload.maxItems,
    maxDepth: config.upload.maxDepth,
    deadlineMs: config.upload.deadlineMs,
    enabled: config.upload.enabled,
  });
}
