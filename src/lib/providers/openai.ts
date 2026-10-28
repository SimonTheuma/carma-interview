import { buildPrompt } from "../enrich/prompt";
import { InvalidOutputError, validateSummaryTopicsOutput } from "../enrich/validate-output";
import { TOPIC_VOCABULARY } from "../enrich/topics";
import { buildTranslatePrompt, stripOutputBidi } from "../translate/prompt";
import { parseTranslatePayload } from "../translate/validate";
import type { EnrichmentProviders, SummaryTopicsResult, TranslateResult } from "./types";

export function createOpenAiProvider(opts: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  tokenCap: number;
  translateModel?: string;
}): Pick<EnrichmentProviders, "summariseAndTag" | "translate"> {
  return {
    async summariseAndTag(text, headline): Promise<SummaryTopicsResult> {
      const prompt = buildPrompt(text, headline, opts.tokenCap);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const schema = {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            summary_confidence: { type: "number" },
            topics: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string", enum: [...TOPIC_VOCABULARY] },
                  confidence: { type: "number" },
                },
                required: ["name", "confidence"],
              },
            },
          },
          required: ["summary", "summary_confidence", "topics"],
        };
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "enrichment", strict: true, schema },
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`openai HTTP ${res.status}`);
          (err as Error & { status: number }).status = res.status;
          throw err;
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        const parsed = JSON.parse(content) as unknown;
        const v = validateSummaryTopicsOutput(parsed);
        if (!v.ok) throw new InvalidOutputError(v.reason);
        return {
          value: v.value,
          raw: json,
          usage: {
            inputTokens: json.usage?.prompt_tokens,
            outputTokens: json.usage?.completion_tokens,
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

    async translate(chunk): Promise<TranslateResult> {
      const prompt = buildTranslatePrompt(chunk);
      const model = opts.translateModel ?? opts.model;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const schema = {
          type: "object",
          additionalProperties: false,
          properties: {
            translation: { type: "string" },
            detected_language: { type: "string" },
          },
          required: ["translation", "detected_language"],
        };
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "translation", strict: true, schema },
            },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const err = new Error(`openai HTTP ${res.status}`);
          (err as Error & { status: number }).status = res.status;
          throw err;
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          model?: string;
        };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          throw new InvalidOutputError("invalid_json");
        }
        const value = parseTranslatePayload(parsed);
        if (!value) throw new InvalidOutputError("invalid_output");
        return {
          translation: stripOutputBidi(value.translation),
          detectedLanguage: value.detected_language,
          raw: { usage: json.usage, model_reported: json.model },
          usage: {
            inputTokens: json.usage?.prompt_tokens,
            outputTokens: json.usage?.completion_tokens,
            estimated: !json.usage,
          },
          model,
          ...(json.model ? { modelReported: json.model } : {}),
          origin: "provider",
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
