export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { getConfig } from "@/lib/config";
import { getWebPool } from "@/lib/db/pool";
import { TextBlock } from "@/components/TextBlock";
import { VersionList } from "@/components/upload/VersionList";
import { TranslatedText } from "@/components/TranslatedText";
import { TranslationNotice } from "@/components/TranslationNotice";
import {
  languageDisplayName,
  selectTranslationPageState,
} from "@/lib/translate/display";
import { needsTranslation } from "@/lib/translate/language";
import { strings } from "@/lib/ui/strings";
import Link from "next/link";
import { notFound } from "next/navigation";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const config = getConfig();
    const pool = getWebPool(config.db);
    const art = await pool.query(
      `SELECT a.headline, a.language, a.version, t.headline_en
         FROM articles a
         LEFT JOIN article_translations t
           ON t.article_id = a.id AND t.article_version = a.version
          AND t.superseded_at IS NULL AND t.target_lang = 'en'
        WHERE a.id = $1`,
      [id],
    );
    const row = art.rows[0];
    if (!row) return { title: "Article" };
    const title =
      (needsTranslation(row.language) && row.headline_en) || row.headline || strings.noHeadline;
    return { title: String(title) };
  } catch {
    return { title: "Article" };
  }
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const config = getConfig();
  const pool = getWebPool(config.db);

  const art = await pool.query(`SELECT * FROM articles WHERE id = $1`, [id]);
  if (!art.rows[0]) notFound();
  const a = art.rows[0];
  const version = Number(a.version ?? 1);
  const langName = languageDisplayName(a.language);

  let translationLoadFailed = false;
  let translationRow: {
    headline_en: string | null;
    body_en: string | null;
    flags: string[] | null;
    created_at: string;
  } | null = null;

  const [derived, jobs, transforms, enrichments, dups, versions] = await Promise.all([
    pool.query(
      `SELECT * FROM derived_values WHERE article_id = $1 AND is_current ORDER BY field, rank`,
      [id],
    ),
    pool.query(
      `SELECT * FROM enrichment_jobs WHERE article_id = $1 AND article_version = $2 ORDER BY part`,
      [id, version],
    ),
    pool.query(`SELECT * FROM ingest_transformations WHERE article_id = $1 ORDER BY id`, [id]),
    pool.query(
      `SELECT * FROM enrichments WHERE article_id = $1 AND article_version = $2 ORDER BY created_at`,
      [id, version],
    ),
    pool.query(
      `SELECT id, external_id, source FROM articles WHERE content_hash = $1 AND id <> $2`,
      [a.content_hash, id],
    ),
    pool.query(
      `SELECT version, published_at, ingested_at, superseded_at, language, headline, body, content_hash, flags
         FROM article_versions WHERE article_id = $1 ORDER BY version DESC`,
      [id],
    ),
  ]);

  try {
    const tr = await pool.query(
      `SELECT headline_en, body_en, flags, created_at
         FROM article_translations
        WHERE article_id = $1 AND article_version = $2
          AND superseded_at IS NULL AND target_lang = 'en'
        LIMIT 1`,
      [id, version],
    );
    translationRow = tr.rows[0] ?? null;
  } catch {
    translationLoadFailed = true;
  }

  const translationJob =
    jobs.rows.find((j: { part: string }) => j.part === "translation") ?? null;
  const translationEnrichment =
    enrichments.rows.find((e: { part: string }) => e.part === "translation") ?? null;

  const pageState = selectTranslationPageState({
    language: a.language,
    translationRow,
    job: translationJob
      ? { state: translationJob.state, reason_code: translationJob.reason_code }
      : null,
    enrichment: translationEnrichment
      ? { trust: translationEnrichment.trust, origin: translationEnrichment.origin }
      : null,
    loadFailed: translationLoadFailed,
  });

  return (
    <div className="space-y-6">
      {pageState.kind !== "translated" && (
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">
            {a.headline ? (
              <TextBlock text={a.headline} lang={a.language} as="span" />
            ) : (
              <span className="italic text-muted">{strings.noHeadline}</span>
            )}
          </h1>
          <p className="text-sm text-muted">
            {a.source} · {langName} ({a.language}) ·{" "}
            {new Date(a.published_at).toISOString()} · id {a.id} · v{version}
          </p>
        </header>
      )}

      {pageState.kind === "translated" && translationRow && (
        <>
          <p className="text-sm text-muted">
            {a.source} · {langName} ({a.language}) ·{" "}
            {new Date(a.published_at).toISOString()} · id {a.id} · v{version}
          </p>
          <TranslatedText
            sourceLang={a.language}
            original={{ headline: a.headline, body: a.body }}
            translation={{
              headline_en: translationRow.headline_en,
              body_en: translationRow.body_en,
            }}
            trust={pageState.lowTrust ? "low" : "normal"}
            mock={pageState.mock}
            modelInfo={{
              model: translationEnrichment?.model ?? "unknown",
              promptVersion: translationEnrichment?.prompt_version ?? "t1",
              producedAt: new Date(translationRow.created_at).toISOString(),
            }}
          />
          {/* Server HTML fallback for no-JS: translation visible, original in details */}
          <noscript>
            <section>
              <h2>English translation</h2>
              <pre className="whitespace-pre-wrap text-sm">{translationRow.body_en}</pre>
              <details>
                <summary>Original text</summary>
                <pre className="whitespace-pre-wrap text-sm">{a.body}</pre>
              </details>
            </section>
          </noscript>
        </>
      )}

      {pageState.kind !== "translated" && pageState.kind !== "not_needed" && (
        <TranslationNotice state={pageState} languageName={langName} />
      )}

      {transforms.rows.length > 0 && (
        <p className="text-sm">
          Markup was removed from this article.{" "}
          <a href="#transforms" className="underline">
            What changed
          </a>
        </p>
      )}

      {pageState.kind !== "translated" && (
        <section>
          <h2 className="font-medium mb-2">Text</h2>
          <TextBlock
            text={a.body ?? ""}
            lang={a.language}
            className="whitespace-pre-wrap text-sm leading-relaxed"
          />
        </section>
      )}

      {(versions.rows.length > 0 || version > 1) && (
        <VersionList
          current={{
            version,
            published_at: a.published_at,
            language: a.language,
            headline: a.headline,
            body: a.body,
            content_hash: a.content_hash,
            flags: a.flags ?? [],
          }}
          older={versions.rows}
        />
      )}

      <section>
        <h2 className="font-medium mb-2">Derived values</h2>
        <ul className="space-y-2 text-sm">
          {derived.rows.map((d) => (
            <li key={d.id}>
              <strong>{d.field}</strong>: {d.value}
              {d.confidence_norm != null && ` (${d.confidence_norm}% · ${d.confidence_origin})`}
            </li>
          ))}
          {derived.rows.length === 0 && <li className="text-muted">None yet</li>}
        </ul>
      </section>

      <section id="transforms">
        <h2 className="font-medium mb-2">Transformations</h2>
        <ul className="text-sm space-y-1">
          {transforms.rows.map((t) => (
            <li key={t.id}>
              {t.field}: {t.kind} ({t.tool} {t.tool_version})
            </li>
          ))}
          {transforms.rows.length === 0 && <li className="text-muted">None</li>}
        </ul>
      </section>

      <section id="trail">
        <h2 className="font-medium mb-2">Processing trail</h2>
        <ul className="text-sm space-y-1">
          {jobs.rows.map((j) => (
            <li key={j.id}>
              Job {j.part}: {j.state}
              {j.reason_code ? ` · ${j.reason_code}` : ""} · attempts {j.attempts}
            </li>
          ))}
          {enrichments.rows.map((e) => (
            <li key={e.id}>
              Enrichment {e.part}: {e.provider}/{e.model} · origin {e.origin} · trust {e.trust}
            </li>
          ))}
        </ul>
      </section>

      {dups.rows.length > 0 && (
        <section>
          <h2 className="font-medium mb-2">Same content</h2>
          <ul className="text-sm">
            {dups.rows.map((d) => (
              <li key={d.id}>
                <Link href={`/articles/${d.id}`} className="underline">
                  {d.source}/{d.external_id}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
