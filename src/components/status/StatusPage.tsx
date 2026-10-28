"use client";

import { useEffect, useState } from "react";

type Status = {
  headline: string;
  articles_total: number;
  jobs: Array<{ part: string; state: string; n: string }>;
  oldest_actionable_job_age_s: number | null;
  budget: Array<{
    provider: string;
    cap_micro: string;
    reserved_micro: string;
    spent_micro: string;
  }>;
  flags: Array<{ key: string; value: string; updated_at: string }>;
  quarantine: { open: number; oldest: string | null };
  watermark: { published_at: string | null; ingested_at: string | null };
  freshness: { note: string };
  gaps: { dead: number; quarantine_open: number };
  generated_at: string;
};

export default function StatusPage() {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<string>("");

  useEffect(() => {
    let alive = true;
    async function load() {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/status");
        if (!r.ok) throw new Error("status failed");
        const j = (await r.json()) as Status;
        if (!alive) return;
        setData(j);
        setUpdated(new Date().toISOString().slice(11, 19));
        setError(null);
      } catch {
        if (alive) setError("Status is temporarily unavailable");
      }
    }
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  }
  if (!data) return <p className="text-muted">Loading status…</p>;

  const hb = data.flags.find((f) => f.key === "worker.heartbeat");

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-baseline">
        <h1 className="text-xl font-semibold">{data.headline}</h1>
        <p className="text-xs text-muted">Last updated {updated} UTC</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Tile title="Articles" value={String(data.articles_total)} state="ok" />
        <Tile
          title="Quarantine open"
          value={String(data.quarantine.open)}
          state={data.quarantine.open > 0 ? "warn" : "ok"}
        />
        <Tile
          title="Dead jobs"
          value={String(data.gaps.dead)}
          state={data.gaps.dead > 0 ? "bad" : "ok"}
        />
        <Tile
          title="Oldest actionable job"
          value={
            data.oldest_actionable_job_age_s != null
              ? `${Math.round(data.oldest_actionable_job_age_s)}s`
              : "—"
          }
          state="ok"
        />
        <Tile title="Freshness" value={data.freshness.note} state="ok" />
        <Tile
          title="Worker heartbeat"
          value={hb ? new Date(hb.value).toISOString().slice(11, 19) + " UTC" : "—"}
          state={hb ? "ok" : "warn"}
        />
      </div>

      <section>
        <h2 className="font-medium mb-2">Jobs by state</h2>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left p-1">Part</th>
              <th className="text-left p-1">State</th>
              <th className="text-right p-1">Count</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={`${j.part}-${j.state}`}>
                <td className="p-1">{j.part}</td>
                <td className="p-1">{j.state}</td>
                <td className="p-1 text-right">{j.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Budget (today UTC)</h2>
        {data.budget.length === 0 && <p className="text-sm text-muted">No spend yet</p>}
        {data.budget.map((b) => {
          const cap = Number(b.cap_micro);
          const used = Number(b.spent_micro) + Number(b.reserved_micro);
          const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
          return (
            <div key={b.provider} className="mb-2">
              <p className="text-sm">
                {b.provider}: {(used / 1e6).toFixed(4)} / {(cap / 1e6).toFixed(2)}{" "}
                {pct >= 100 ? "(cap reached)" : ""}
              </p>
              <div className="h-2 bg-border rounded overflow-hidden">
                <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="font-medium mb-2">Breakers & flags</h2>
        <ul className="text-sm space-y-1">
          {data.flags
            .filter((f) => f.key.startsWith("breaker.") || f.key === "enrichment_enabled")
            .map((f) => (
              <li key={f.key}>
                {f.key}: {f.value}
              </li>
            ))}
        </ul>
      </section>
    </div>
  );
}

function Tile({
  title,
  value,
  state,
}: {
  title: string;
  value: string;
  state: "ok" | "warn" | "bad";
}) {
  const label = state === "ok" ? "OK" : state === "warn" ? "Attention" : "Problem";
  return (
    <div className="border border-border bg-surface rounded p-3">
      <p className="text-xs text-muted">
        {title} · {label}
      </p>
      <p className="text-lg font-medium mt-1">{value}</p>
    </div>
  );
}
