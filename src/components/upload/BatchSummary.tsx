"use client";

import { strings } from "@/lib/ui/strings";

type Props = {
  received: number;
  admitted: number;
  duplicate: number;
  quarantined: number;
  versions: number;
  batchId: string;
  reconciled: boolean;
};

export function BatchSummary(props: Props) {
  const {
    received,
    admitted,
    duplicate,
    quarantined,
    versions,
    batchId,
    reconciled,
  } = props;

  return (
    <div className="space-y-2 text-sm">
      <p>
        Received {received}: admitted {admitted}, duplicates {duplicate}, quarantined{" "}
        {quarantined}
        {versions > 0 ? `, new versions: ${versions}` : ""}
      </p>
      <p className={reconciled ? "text-muted" : "text-red-700 font-medium"}>
        {reconciled ? strings.uploadReconciled(received) : strings.uploadNotReconciled}
      </p>
      <p className="flex items-center gap-2">
        <span className="font-mono text-xs">batch {batchId}</span>
        <button
          type="button"
          className="underline text-xs"
          onClick={() => void navigator.clipboard.writeText(batchId)}
        >
          Copy
        </button>
      </p>
      <p className="text-muted text-xs">{strings.quarantineNote}</p>
    </div>
  );
}
