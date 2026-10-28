"use client";

import { useState } from "react";
import Link from "next/link";
import { TextBlock } from "./TextBlock";
import { MatchedInTag, type MatchSide } from "./MatchedInTag";
import { strings } from "@/lib/ui/strings";
import { selectHeadlinePair } from "@/lib/translate/headline-pair";
import { languageDisplayName } from "@/lib/translate/display";

type Derived = {
  field: string;
  value: string;
  confidence_norm: string | number | null;
  confidence_origin: string;
  method: string;
  scale_min?: number;
  scale_max?: number;
  extra?: unknown;
};

type Job = { part: string; state: string; reason_code?: string | null };

export function ArticleCard({ article }: { article: Record<string, unknown> }) {
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [showEnBody, setShowEnBody] = useState(false);
  const [showOrigBody, setShowOrigBody] = useState(false);

  const headline = article.headline as string | null;
  const headlineEn = article.headline_en as string | null | undefined;
  const bodyExcerpt = article.body_excerpt as string | null | undefined;
  const bodyExcerptEn = article.body_excerpt_en as string | null | undefined;
  const lang = article.language as string;
  const flags = (article.flags as string[]) ?? [];
  const derived = (article.derived as Derived[]) ?? [];
  const jobs = (article.jobs as Job[]) ?? [];
  const sentiment = derived.find((d) => d.field === "sentiment");
  const summary = derived.find((d) => d.field === "summary");
  const topics = derived.filter((d) => d.field === "topic");
  const sentJob = jobs.find((j) => j.part === "sentiment");
  const sumJob = jobs.find((j) => j.part === "summary_topics");
  const trJob = jobs.find((j) => j.part === "translation");

  const rawMatched = article.matched_in;
  const matchedSides: MatchSide[] = Array.isArray(rawMatched)
    ? (rawMatched as string[]).filter((s): s is MatchSide =>
        s === "original" || s === "translation" || s === "summary",
      )
    : rawMatched === "both"
      ? ["original", "translation"]
      : rawMatched === "translation"
        ? ["translation"]
        : rawMatched === "summary"
          ? ["summary"]
          : ["original"];

  const pair = selectHeadlinePair({
    language: lang,
    headline,
    headlineEn,
    bodyEn: bodyExcerptEn ?? null,
    jobs,
  });

  const mock = derived.some((d) => d.confidence_origin === "mock");
  const translationMock = trJob?.state === "succeeded" && mock;
  const lowTrust = flags.includes("possible_prompt_injection");
  const langName = languageDisplayName(lang);

  function enrichmentLabel(job: Job | undefined, hasValue: boolean): string {
    if (hasValue) return "";
    if (!job) return "Pending";
    switch (job.state) {
      case "queued":
      case "running":
        return "Pending";
      case "deferred_budget":
        return "Paused";
      case "dead":
        return "Unavailable";
      case "skipped_no_content":
        return "Not applicable";
      case "failed_retryable":
        return "Pending";
      default:
        return "Pending";
    }
  }

  const summaryText = summary?.value
    ? summary.value
    : sumJob?.state === "deferred_budget"
      ? "Enrichment paused: daily budget reached"
      : sumJob?.state === "dead"
        ? "Enrichment unavailable"
        : sumJob?.state === "skipped_no_content"
          ? "No text to analyse"
          : sumJob?.state === "failed_retryable"
            ? "Enrichment delayed, retrying"
            : "Not yet enriched";

  const hasEnExcerpt = Boolean(bodyExcerptEn?.trim());
  const hasOrigExcerpt = Boolean(bodyExcerpt?.trim());

  return (
    <article className="border border-border bg-surface rounded p-4 space-y-2">
      <h2 className="text-base font-semibold" lang={pair.primaryLang}>
        {pair.primary === strings.noHeadline ? (
          <span className="italic text-muted" title="The source did not supply a headline">
            {strings.noHeadline}
          </span>
        ) : (
          <TextBlock text={pair.primary} lang={pair.primaryLang} as="span" />
        )}
      </h2>
      {pair.secondary && (
        <p className="text-sm text-muted" lang={pair.secondaryLang ?? undefined} dir="auto">
          {pair.secondary}
        </p>
      )}
      {pair.note && <p className="text-sm text-muted">{pair.note}</p>}
      <MatchedInTag sides={matchedSides} mock={Boolean(translationMock)} />
      <p className="text-xs text-muted">
        {String(article.source)} · {lang.toUpperCase()}
        {pair.showMachineTranslatedTag && (
          <>
            {" · "}
            <span className="text-muted">{strings.machineTranslatedTag}</span>
          </>
        )}{" "}
        ·{" "}
        <time dateTime={String(article.published_at)} title={String(article.published_at)}>
          {new Date(String(article.published_at)).toISOString().replace("T", " ").slice(0, 16)} UTC
        </time>
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        {flags.includes("markup_removed") && (
          <span className="border border-border px-1.5 py-0.5 rounded">Markup removed</span>
        )}
        {lowTrust && (
          <span className="border border-warn text-warn px-1.5 py-0.5 rounded">
            Possible prompt injection
          </span>
        )}
      </div>
      <div>
        <p className="text-xs text-muted mb-0.5">
          {mock ? strings.mockOutput : strings.aiSummary}
        </p>
        <TextBlock text={summaryText} lang="en" className="text-sm" />
      </div>
      <div className="flex flex-wrap gap-3 items-center text-sm">
        {sentiment ? (
          <span>
            Sentiment: {sentiment.value}{" "}
            {sentiment.confidence_norm != null && (
              <>
                {Number(sentiment.confidence_norm).toFixed(0)}%
                <button
                  type="button"
                  className="ml-1 underline text-xs"
                  aria-expanded={whyOpen === "sentiment"}
                  onClick={() => setWhyOpen(whyOpen === "sentiment" ? null : "sentiment")}
                >
                  {strings.why}
                </button>
              </>
            )}
            {whyOpen === "sentiment" && (
              <WhyBox
                origin={sentiment.confidence_origin}
                method={sentiment.method}
                raw={sentiment.confidence_norm}
              />
            )}
          </span>
        ) : (
          <span className="text-muted">Sentiment: {enrichmentLabel(sentJob, false)}</span>
        )}
        {topics.length > 0
          ? topics.map((t) => (
              <Link
                key={t.value}
                href={`/?topic=${encodeURIComponent(t.value)}`}
                className="border border-border rounded-full px-2 py-0.5 text-xs no-underline text-foreground"
              >
                {t.value}
                {t.confidence_norm != null ? ` ${Number(t.confidence_norm).toFixed(0)}%` : ""}
              </Link>
            ))
          : (
            <span className="text-muted text-xs">Topics: {enrichmentLabel(sumJob, false)}</span>
          )}
      </div>
      {(hasEnExcerpt || hasOrigExcerpt) && (
        <div className="space-y-1">
          <button
            type="button"
            className="text-xs underline"
            aria-expanded={showEnBody}
            onClick={() => {
              setShowEnBody(!showEnBody);
              if (showEnBody) setShowOrigBody(false);
            }}
          >
            {showEnBody ? "Hide text" : "Show more"}
          </button>
          {showEnBody && (
            <div className="space-y-2">
              {hasEnExcerpt ? (
                <TextBlock
                  text={bodyExcerptEn!}
                  lang="en"
                  className="mt-1 text-sm whitespace-pre-wrap"
                />
              ) : hasOrigExcerpt ? (
                <>
                  <p className="text-xs text-muted">{strings.bodyNotTranslated}</p>
                  <TextBlock
                    text={bodyExcerpt!}
                    lang={lang}
                    className="mt-1 text-sm whitespace-pre-wrap"
                  />
                </>
              ) : null}
              {hasEnExcerpt && hasOrigExcerpt && (
                <>
                  <button
                    type="button"
                    className="text-xs underline"
                    aria-expanded={showOrigBody}
                    onClick={() => setShowOrigBody(!showOrigBody)}
                  >
                    {showOrigBody ? strings.hideOriginalText : strings.showOriginalText}
                  </button>
                  {showOrigBody && (
                    <div>
                      <p className="text-xs text-muted mb-0.5">
                        {strings.originalTextLang(langName)}
                      </p>
                      <TextBlock
                        text={bodyExcerpt!}
                        lang={lang}
                        className="text-sm whitespace-pre-wrap"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
      <Link href={`/articles/${article.id}`} className="text-sm text-accent">
        Details
      </Link>
    </article>
  );
}

function WhyBox({
  origin,
  method,
  raw,
}: {
  origin: string;
  method: string;
  raw: string | number | null;
}) {
  const explanation =
    origin === "classifier_concentration"
      ? "Classifier confidence measures how decisive the choice was. It is not the chance the label is right."
      : origin === "llm_self_report"
        ? "This confidence is self-reported by the language model."
        : origin === "mock"
          ? "Mock output from the local lexicon adapter (no external API call)."
          : "No confidence available.";
  return (
    <div className="mt-1 text-xs border border-border rounded p-2 bg-background max-w-md">
      <p>{explanation}</p>
      <p className="mt-1 text-muted">
        Origin: {origin} · Method: {method} · Value: {raw}
      </p>
    </div>
  );
}
