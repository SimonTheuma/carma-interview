import { TextBlock } from "@/components/TextBlock";
import { strings } from "@/lib/ui/strings";

export type VersionRow = {
  version: number;
  published_at: string | Date;
  ingested_at?: string | Date;
  superseded_at?: string | Date | null;
  language: string;
  headline: string | null;
  body: string | null;
  content_hash: Buffer | string;
  flags: string[];
  current?: boolean;
};

function shortHash(h: Buffer | string): string {
  const buf = typeof h === "string" ? Buffer.from(h.replace(/^\\x/, ""), "hex") : Buffer.from(h);
  return buf.subarray(0, 4).toString("hex");
}

export function VersionList({
  current,
  older,
}: {
  current: VersionRow;
  older: VersionRow[];
}) {
  const all = [
    { ...current, current: true },
    ...older.map((v) => ({ ...v, current: false })),
  ].sort((a, b) => b.version - a.version);

  return (
    <section className="space-y-3">
      <h2 className="font-medium">{strings.versionHistory}</h2>
      <ul className="space-y-3 text-sm">
        {all.map((v) => (
          <li key={v.version} className="border-b border-border pb-3">
            <p>
              v{v.version}
              {v.current ? ` · ${strings.currentVersion}` : ""} · hash {shortHash(v.content_hash)}
              {v.flags?.length ? ` · ${v.flags.join(", ")}` : ""}
            </p>
            <p className="text-xs text-muted">
              published {new Date(v.published_at).toISOString()}
              {v.superseded_at
                ? ` · superseded ${new Date(v.superseded_at).toISOString()}`
                : ""}
            </p>
            {!v.current && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs underline">Show text</summary>
                <div className="mt-2 space-y-2">
                  {v.headline && (
                    <TextBlock text={v.headline} lang={v.language} className="font-medium" />
                  )}
                  <TextBlock
                    text={v.body ?? ""}
                    lang={v.language}
                    className="whitespace-pre-wrap text-xs"
                  />
                </div>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
