import { Suspense } from "react";
import TrendsPage from "@/components/trends/TrendsPage";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-muted">Loading trends…</p>}>
      <TrendsPage />
    </Suspense>
  );
}
