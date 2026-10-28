"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { strings } from "@/lib/ui/strings";
import { UploadForm, type UploadSuccess } from "./UploadForm";
import { BatchSummary } from "./BatchSummary";
import { EnrichmentProgress } from "./EnrichmentProgress";
import { BatchTable, type BatchRow } from "./BatchTable";

type Limits = { maxBytes: number; maxItems: number; enabled: boolean };

type Props = { initialLimits: Limits };

export function UploadPage({ initialLimits }: Props) {
  const search = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadSuccess | null>(null);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [enrichment, setEnrichment] = useState({
    enriched: 0,
    waiting: 0,
    deferred: 0,
    failed: 0,
    admitted: 0,
  });
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [pollFails, setPollFails] = useState(0);

  const applyBatch = useCallback((data: {
    received: number;
    admitted: number;
    duplicate: number;
    quarantined: number;
    versions: number;
    batchId: string;
    reconciled: boolean;
    enrichment?: typeof enrichment;
    items: BatchRow[];
  }) => {
    setSummary({
      received: data.received,
      admitted: data.admitted,
      duplicate: data.duplicate,
      quarantined: data.quarantined,
      versions: data.versions,
      batchId: data.batchId,
      reconciled: data.reconciled,
      items: data.items,
    });
    setRows(data.items);
    if (data.enrichment) setEnrichment(data.enrichment);
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  const loadBatch = useCallback(
    async (batchId: string) => {
      try {
        const res = await fetch(`/api/uploads/${batchId}`);
        if (!res.ok) {
          setPollFails((n) => n + 1);
          return false;
        }
        const data = await res.json();
        applyBatch(data);
        setPollFails(0);
        return (data.enrichment?.waiting ?? 0) + (data.enrichment?.deferred ?? 0) > 0;
      } catch {
        setPollFails((n) => n + 1);
        return false;
      }
    },
    [applyBatch],
  );

  useEffect(() => {
    const batch = search.get("batch");
    if (batch) void loadBatch(batch);
  }, [search, loadBatch]);

  useEffect(() => {
    if (!summary?.batchId) return;
    const open = enrichment.waiting + enrichment.deferred > 0;
    if (!open) return;
    const t = setInterval(() => {
      void loadBatch(summary.batchId);
    }, 3000);
    return () => clearInterval(t);
  }, [summary?.batchId, enrichment.waiting, enrichment.deferred, loadBatch]);

  function onSuccess(body: UploadSuccess) {
    setError(null);
    setSummary(body);
    setRows(
      body.items.map((i) => ({
        ...i,
        sentimentState: null,
        summaryTopicsState: null,
      })),
    );
    setEnrichment({
      enriched: 0,
      waiting: body.admitted,
      deferred: 0,
      failed: 0,
      admitted: body.admitted,
    });
    router.replace(`/upload?batch=${body.batchId}`);
    void loadBatch(body.batchId);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{strings.uploadTitle}</h1>
      <UploadForm
        limits={initialLimits}
        onSuccess={onSuccess}
        onError={(msg, batchId) => {
          setError(msg);
          if (batchId) void loadBatch(batchId);
        }}
      />
      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {summary && (
        <>
          <BatchSummary {...summary} />
          <EnrichmentProgress {...enrichment} lastUpdated={lastUpdated} />
          {pollFails >= 3 && (
            <p className="text-sm text-muted">
              {strings.progressStale}{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void loadBatch(summary.batchId)}
              >
                Retry
              </button>
            </p>
          )}
          <BatchTable rows={rows} />
        </>
      )}
    </div>
  );
}
