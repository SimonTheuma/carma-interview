import { InvalidOutputError, validateSentimentOutput } from "../enrich/validate-output";
import type { EnrichmentProviders, SentimentResult } from "./types";

export function createJevProvider(opts: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): Pick<EnrichmentProviders, "classifySentiment"> {
  return {
    async classifySentiment(text, headline): Promise<SentimentResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const body = {
          state: `${headline ? headline + "\n\n" : ""}${text}`.slice(0, 12000),
          model: opts.model,
          questions: {
            sentiment: {
              type: "choice",
              instructions: "Classify the overall sentiment of this news article.",
              criteria: {
                positive: "Optimistic or favourable tone",
                negative: "Critical, alarming or unfavourable tone",
                neutral: "Balanced or factual without clear polarity",
                mixed: "Contains both positive and negative elements",
              },
            },
          },
        };
        const res = await fetch(opts.baseUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`jev HTTP ${res.status}`);
          (err as Error & { status: number }).status = res.status;
          throw err;
        }
        const json = (await res.json()) as {
          answers?: {
            sentiment?: {
              choice?: string;
              confidence?: number;
              probabilities?: Record<string, number>;
            };
          };
          usage?: { input_tokens?: number; output_tokens?: number };
          model?: string;
        };
        const ans = json.answers?.sentiment;
        const raw = {
          choice: ans?.choice,
          confidence: ans?.confidence ?? 0,
          probabilities: ans?.probabilities,
        };
        const v = validateSentimentOutput(raw);
        if (!v.ok) throw new InvalidOutputError(v.reason);
        return {
          value: v.value,
          raw: json,
          usage: {
            inputTokens: json.usage?.input_tokens,
            outputTokens: json.usage?.output_tokens,
            estimated: !json.usage,
          },
          model: opts.model,
          ...(json.model ? { modelReported: json.model } : {}),
          origin: "provider",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
