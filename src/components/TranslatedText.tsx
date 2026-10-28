"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TextBlock } from "./TextBlock";
import { strings } from "@/lib/ui/strings";
import { languageDisplayName } from "@/lib/translate/display";
import { selectHeadlinePair } from "@/lib/translate/headline-pair";

type Props = {
  sourceLang: string;
  original: { headline: string | null; body: string | null };
  translation: { headline_en: string | null; body_en: string | null };
  trust: "normal" | "low";
  mock: boolean;
  modelInfo: { model: string; promptVersion: string; producedAt: string };
};

export function TranslatedText(props: Props) {
  const [live, setLive] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const textId = useId();
  const langName = languageDisplayName(props.sourceLang);

  const pair = selectHeadlinePair({
    language: props.sourceLang,
    headline: props.original.headline,
    headlineEn: props.translation.headline_en,
    bodyEn: props.translation.body_en,
  });

  useEffect(() => {
    const el = detailsRef.current;
    if (!el) return;
    function onToggle() {
      const open = detailsRef.current?.open ?? false;
      setLive(
        open ? strings.liveOriginal(langName) : strings.liveTranslation,
      );
      try {
        navigator.sendBeacon?.(
          "/api/telemetry/translation-view",
          new Blob(
            [JSON.stringify({ view: open ? "original_shown" : "original_hidden" })],
            { type: "application/json" },
          ),
        );
      } catch {
        // silent
      }
    }
    el.addEventListener("toggle", onToggle);
    return () => el.removeEventListener("toggle", onToggle);
  }, [langName]);

  const label = props.mock
    ? strings.translationMockLabel
    : langName !== "unknown"
      ? strings.translationLabel(langName)
      : strings.translationLabelUnknown;

  const hasOriginalBody = Boolean(props.original.body?.trim());
  const hasEnglishBody = Boolean(props.translation.body_en?.trim());

  return (
    <div className="space-y-3">
      <div className="border border-border rounded px-3 py-2 bg-surface space-y-1">
        <p className="text-sm font-medium">{label}</p>
        {props.trust === "low" && (
          <p className="text-sm text-amber-800" role="alert">
            ⚠ {strings.translationLowTrust}
          </p>
        )}
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{strings.translationDisclaimer}</summary>
          <p className="mt-1">
            {strings.translationAbout(
              props.modelInfo.model,
              props.modelInfo.producedAt,
              props.modelInfo.promptVersion,
            )}
          </p>
        </details>
      </div>

      <div aria-live="polite" className="sr-only">
        {live}
      </div>

      <h1 className="text-xl font-semibold" lang={pair.primaryLang}>
        {pair.primary === strings.noHeadline ? (
          <span className="italic text-muted">{strings.noHeadline}</span>
        ) : (
          <TextBlock text={pair.primary} lang={pair.primaryLang} as="span" />
        )}
      </h1>
      {pair.secondary && (
        <p className="text-sm text-muted" lang={pair.secondaryLang ?? undefined} dir="auto">
          {pair.secondary}
        </p>
      )}
      {pair.note && <p className="text-sm text-muted">{pair.note}</p>}

      <div id={textId}>
        {hasEnglishBody ? (
          <TextBlock
            text={props.translation.body_en ?? ""}
            lang="en"
            className="whitespace-pre-wrap text-sm leading-relaxed"
          />
        ) : (
          <TextBlock
            text={props.original.body ?? ""}
            lang={props.sourceLang}
            className="whitespace-pre-wrap text-sm leading-relaxed"
          />
        )}
      </div>

      {hasEnglishBody && hasOriginalBody && (
        <details ref={detailsRef} className="border border-border rounded px-3 py-2">
          <summary className="cursor-pointer text-sm min-h-11 flex items-center">
            {strings.showOriginalTextLang(langName)}
          </summary>
          <div className="mt-2 pt-2 border-t border-border">
            <p className="text-xs text-muted mb-1">{strings.originalTextLang(langName)}</p>
            <TextBlock
              text={props.original.body ?? ""}
              lang={props.sourceLang}
              className="whitespace-pre-wrap text-sm leading-relaxed"
            />
          </div>
        </details>
      )}
    </div>
  );
}
