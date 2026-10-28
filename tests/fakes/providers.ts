import type {
  EnrichmentProviders,
  SentimentResult,
  SummaryTopicsResult,
  TranslateResult,
} from "@/lib/providers/types";
import { mockTranslateText } from "@/lib/providers/mock";

/** In-process providers that record calls for cache-hit / fault tests. */
export function createRecordingProviders(opts?: {
  sentiment?: SentimentResult;
  summary?: SummaryTopicsResult;
  translate?: TranslateResult | ((chunk: string) => TranslateResult | Promise<TranslateResult>);
}): EnrichmentProviders & { calls: { sentiment: number; summary: number; translate: number } } {
  const calls = { sentiment: 0, summary: 0, translate: 0 };
  const sentiment: SentimentResult = opts?.sentiment ?? {
    value: { choice: "neutral", confidence: 0.5 },
    raw: { choice: "neutral", confidence: 0.5 },
    usage: { inputTokens: 10, outputTokens: 5, estimated: true },
    model: "fake-sentiment",
    origin: "mock",
  };
  const summary: SummaryTopicsResult = opts?.summary ?? {
    value: {
      summary: "A short summary.",
      summary_confidence: 0.7,
      topics: [{ name: "Other", confidence: 0.5 }],
    },
    raw: {},
    usage: { inputTokens: 20, outputTokens: 40, estimated: true },
    model: "fake-summary",
    origin: "mock",
  };
  return {
    calls,
    async classifySentiment() {
      calls.sentiment++;
      return sentiment;
    },
    async summariseAndTag() {
      calls.summary++;
      return summary;
    },
    async translate(chunk) {
      calls.translate++;
      if (typeof opts?.translate === "function") return opts.translate(chunk);
      if (opts?.translate) return opts.translate;
      const translation = mockTranslateText(chunk);
      return {
        translation,
        detectedLanguage: "en",
        raw: { translation, detected_language: "en" },
        usage: { inputTokens: 10, outputTokens: 10, estimated: true },
        model: "fake-translate",
        origin: "mock" as const,
      };
    },
  };
}
