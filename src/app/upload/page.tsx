export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { getConfig } from "@/lib/config";
import { UploadPage } from "@/components/upload/UploadPage";
import { startEventLoopLagSampler } from "@/lib/upload/event-loop";

startEventLoopLagSampler();

export default function UploadRoute() {
  const config = getConfig();
  const limits = {
    maxBytes: config.upload.maxBytes,
    maxItems: config.upload.maxItems,
    enabled: config.upload.enabled,
  };
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <UploadPage initialLimits={limits} />
    </Suspense>
  );
}
