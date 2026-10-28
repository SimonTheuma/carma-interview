import type { AppConfig } from "../config";
import { createMockProviders } from "./mock";
import { createJevProvider } from "./jev";
import { createOpenAiProvider } from "./openai";
import type { EnrichmentProviders } from "./types";

export function createProviders(config: AppConfig): EnrichmentProviders {
  const mock = createMockProviders(config.mockLatencyMs);
  const jev =
    config.jev.mode === "real" && config.jev.apiKey
      ? createJevProvider({
          apiKey: config.jev.apiKey,
          baseUrl: config.jev.baseUrl,
          model: config.jev.model,
          timeoutMs: config.callTimeoutMs,
        })
      : null;
  const openai =
    config.openai.mode === "real" && config.openai.apiKey && config.openai.model
      ? createOpenAiProvider({
          apiKey: config.openai.apiKey,
          model: config.openai.model,
          timeoutMs: config.callTimeoutMs,
          tokenCap: config.inputTokenCap,
          ...(config.translation.model ? { translateModel: config.translation.model } : {}),
        })
      : null;

  return {
    classifySentiment: (text, headline) =>
      jev ? jev.classifySentiment(text, headline) : mock.classifySentiment(text, headline),
    summariseAndTag: (text, headline) =>
      openai ? openai.summariseAndTag(text, headline) : mock.summariseAndTag(text, headline),
    translate: (chunk, opts) =>
      openai ? openai.translate(chunk, opts) : mock.translate(chunk, opts),
  };
}

export type { EnrichmentProviders } from "./types";
