import { Suspense } from "react";
import SearchPage from "@/components/search/SearchPage";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-muted">Loading search…</p>}>
      <SearchPage />
    </Suspense>
  );
}
