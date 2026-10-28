"use client";

import { useRef, useState } from "react";
import { strings } from "@/lib/ui/strings";

export type UploadSuccess = {
  received: number;
  admitted: number;
  duplicate: number;
  quarantined: number;
  versions: number;
  batchId: string;
  reconciled: boolean;
  items: Array<{
    position: number;
    outcome: string;
    reasonCodes: string[];
    articleId: string | null;
    articleVersion: number | null;
    externalId?: string | null;
    source?: string | null;
  }>;
};

type Props = {
  limits: { maxBytes: number; maxItems: number; enabled: boolean };
  onSuccess: (body: UploadSuccess) => void;
  onError: (message: string, batchId?: string) => void;
};

function formatBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(0)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

export function UploadForm({ limits, onSuccess, onError }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  if (!limits.enabled) {
    return <p className="text-sm text-muted">{strings.uploadDisabled}</p>;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads", {
        method: "POST",
        body: fd,
        signal: ac.signal,
      });
      const body = (await res.json()) as UploadSuccess & {
        error?: string;
        reason?: string;
        batchId?: string;
      };
      if (!res.ok) {
        onError(body.error ?? body.reason ?? `HTTP ${res.status}`, body.batchId);
        return;
      }
      onSuccess(body);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") {
        onError(
          "Request cancelled. The server may have stored some articles; check the batch report",
        );
      } else {
        onError(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span>{strings.uploadFileLabel}</span>
        <input
          type="file"
          accept=".json,application/json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
      </label>
      <button
        type="submit"
        disabled={busy || !file}
        className="px-3 py-1.5 bg-foreground text-surface text-sm disabled:opacity-50"
      >
        {busy ? strings.uploading : strings.uploadButton}
      </button>
      {busy && (
        <button
          type="button"
          className="text-sm underline"
          onClick={() => abortRef.current?.abort()}
        >
          Cancel
        </button>
      )}
      <p className="basis-full text-xs text-muted">
        {strings.uploadHint
          .replace("{maxBytes}", formatBytes(limits.maxBytes))
          .replace("{maxItems}", String(limits.maxItems))}
        {file ? ` · ${file.name} (${formatBytes(file.size)})` : ""}
      </p>
    </form>
  );
}
