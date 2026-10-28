import { TOPIC_VOCABULARY } from "../enrich/topics";
import {
  InvalidOutputError,
  validateSentimentOutput,
  validateSummaryTopicsOutput,
} from "../enrich/validate-output";
import type {
  EnrichmentProviders,
  SentimentResult,
  SummaryTopicsResult,
  TranslateResult,
} from "./types";

/** Common English stop words used so mock output passes language validators. */
const MOCK_EN_WORDS = [
  "the",
  "and",
  "of",
  "to",
  "in",
  "for",
  "is",
  "are",
  "with",
  "that",
  "this",
  "from",
  "on",
  "as",
  "by",
  "at",
  "was",
  "were",
  "be",
  "not",
  "article",
  "reports",
  "about",
  "events",
  "today",
  "according",
  "sources",
  "said",
  "officials",
  "people",
];

function mockTranslateParagraph(inputPara: string): string {
  const targetLen = Math.max(24, Math.floor([...inputPara].length * 0.9));
  const words: string[] = ["[mock translation]"];
  let i = 0;
  while (words.join(" ").length < targetLen) {
    words.push(MOCK_EN_WORDS[i % MOCK_EN_WORDS.length]!);
    i++;
  }
  return words.join(" ");
}

export function mockTranslateText(chunk: string): string {
  const paras = chunk
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return mockTranslateParagraph(chunk || "x");
  return paras.map(mockTranslateParagraph).join("\n\n");
}

const POS = ["surge", "growth", "high", "record", "gain", "positive", "boost", "success"];
const NEG = ["breach", "shortage", "risk", "concern", "disruption", "fall", "crisis", "warn"];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createMockProviders(latencyMs = 50): EnrichmentProviders {
  return {
    async classifySentiment(text, _headline): Promise<SentimentResult> {
      await sleep(latencyMs);
      const lower = text.toLowerCase();
      let pos = 0.25;
      let neg = 0.25;
      let neu = 0.35;
      let mix = 0.15;
      for (const w of POS) if (lower.includes(w)) pos += 0.08;
      for (const w of NEG) if (lower.includes(w)) neg += 0.08;
      const sum = pos + neg + neu + mix;
      pos /= sum;
      neg /= sum;
      neu /= sum;
      mix /= sum;
      const probs = { positive: pos, negative: neg, neutral: neu, mixed: mix };
      const choice = (Object.entries(probs).sort((a, b) => b[1] - a[1])[0]![0] as
        | "positive"
        | "negative"
        | "neutral"
        | "mixed");
      const confidence = Math.max(pos, neg, neu, mix);
      const raw = { choice, confidence, probabilities: probs };
      const v = validateSentimentOutput(raw);
      if (!v.ok) throw new InvalidOutputError(v.reason);
      return {
        value: v.value,
        raw,
        usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 20, estimated: true },
        model: "mock-sentiment-v1",
        origin: "mock",
      };
    },

    async summariseAndTag(text, headline): Promise<SummaryTopicsResult> {
      await sleep(latencyMs);
      const sentences = text.split(/(?<=[.!?۔。])\s+/).filter(Boolean);
      const summary = sentences.slice(0, 2).join(" ").slice(0, 500) || (headline ?? "No summary");
      const lower = `${headline ?? ""} ${text}`.toLowerCase();
      const scored = TOPIC_VOCABULARY.map((name) => {
        const key = name.toLowerCase().split(/[&\s]+/)[0]!;
        let score = 0;
        if (lower.includes(key)) score += 0.5;
        if (name === "Artificial Intelligence" && /\bai\b/.test(lower)) score += 0.6;
        if (name === "Energy" && /oil|renewable|solar|wind/.test(lower)) score += 0.5;
        if (name === "Geopolitics" && /geopolitical|middle east|tensions/.test(lower)) score += 0.5;
        if (name === "Real Estate" && /عقار|property|real estate/.test(lower)) score += 0.6;
        if (name === "Technology" && /科技|tech|cloud/.test(lower)) score += 0.5;
        if (name === "Healthcare & Pharma" && /healthcare|diagnostic|hospital/.test(lower))
          score += 0.5;
        if (name === "Cybersecurity" && /breach|security|vulnerability/.test(lower)) score += 0.6;
        if (name === "Finance & Markets" && /bank|rate|earnings|funding/.test(lower)) score += 0.4;
        return { name, confidence: Math.min(0.95, 0.4 + score) };
      })
        .filter((t) => t.confidence > 0.45)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 3);
      const topics =
        scored.length > 0
          ? scored
          : [{ name: "Other" as const, confidence: 0.5 }];
      const raw = {
        summary,
        summary_confidence: 0.7,
        topics,
      };
      const v = validateSummaryTopicsOutput(raw);
      if (!v.ok) throw new InvalidOutputError(v.reason);
      return {
        value: v.value,
        raw,
        usage: { inputTokens: Math.ceil(text.length / 4), outputTokens: 80, estimated: true },
        model: "mock-summary-v1",
        origin: "mock",
      };
    },

    async translate(chunk, _opts): Promise<TranslateResult> {
      await sleep(latencyMs);
      const translation = mockTranslateText(chunk);
      const raw = { translation, detected_language: "en" };
      return {
        translation,
        detectedLanguage: "en",
        raw,
        usage: {
          inputTokens: Math.ceil(chunk.length / 4),
          outputTokens: Math.ceil(translation.length / 4),
          estimated: true,
        },
        model: "mock-translate-v1",
        origin: "mock",
      };
    },
  };
}
