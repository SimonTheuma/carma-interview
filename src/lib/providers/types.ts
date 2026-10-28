import type { ValidatedSentiment, ValidatedSummaryTopics } from "../enrich/validate-output";

export type ProviderUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  estimated?: boolean | undefined;
};

export type SentimentResult = {
  value: ValidatedSentiment;
  raw: unknown;
  usage: ProviderUsage;
  model: string;
  modelReported?: string;
  origin: "provider" | "mock";
};

export type SummaryTopicsResult = {
  value: ValidatedSummaryTopics;
  raw: unknown;
  usage: ProviderUsage;
  model: string;
  modelReported?: string;
  origin: "provider" | "mock";
};

export type TranslateResult = {
  translation: string;
  detectedLanguage: string;
  raw: unknown;
  usage: ProviderUsage;
  model: string;
  modelReported?: string;
  origin: "provider" | "mock" | "cache";
};

export type EnrichmentProviders = {
  classifySentiment(text: string, headline: string | null): Promise<SentimentResult>;
  summariseAndTag(text: string, headline: string | null): Promise<SummaryTopicsResult>;
  translate(
    chunk: string,
    opts?: { sourceLang?: string | null },
  ): Promise<TranslateResult>;
};
