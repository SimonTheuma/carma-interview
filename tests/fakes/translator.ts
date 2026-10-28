import { mockTranslateText } from "@/lib/providers/mock";
import type { TranslateResult } from "@/lib/providers/types";

export type TranslatorMode =
  | "ok"
  | "echo"
  | "empty"
  | "wrong_lang"
  | "refuse"
  | "fail_on_chunk"
  | "timeout"
  | "http_429"
  | "http_500"
  | "malformed";

/** Fake translator with controllable modes; records calls per chunk index. */
export function createFakeTranslator(opts?: {
  mode?: TranslatorMode;
  failChunk?: number;
}): {
  translate: (chunk: string, idx?: number) => Promise<TranslateResult>;
  calls: number[];
  setMode: (m: TranslatorMode) => void;
} {
  let mode: TranslatorMode = opts?.mode ?? "ok";
  const calls: number[] = [];
  let callN = 0;

  return {
    calls,
    setMode(m) {
      mode = m;
    },
    async translate(chunk, idx) {
      const i = idx ?? callN++;
      calls.push(i);
      if (mode === "timeout") {
        const err = new Error("aborted");
        (err as Error & { name: string }).name = "AbortError";
        throw err;
      }
      if (mode === "http_429") {
        const err = new Error("openai HTTP 429");
        (err as Error & { status: number }).status = 429;
        throw err;
      }
      if (mode === "http_500") {
        const err = new Error("openai HTTP 500");
        (err as Error & { status: number }).status = 500;
        throw err;
      }
      if (mode === "fail_on_chunk" && i === (opts?.failChunk ?? 7)) {
        const err = new Error("openai HTTP 500");
        (err as Error & { status: number }).status = 500;
        throw err;
      }
      if (mode === "malformed") {
        return {
          translation: "",
          detectedLanguage: "",
          raw: {},
          usage: {},
          model: "fake",
          origin: "mock",
        };
      }
      if (mode === "empty") {
        return {
          translation: "   ",
          detectedLanguage: "en",
          raw: { translation: "   ", detected_language: "en" },
          usage: {},
          model: "fake",
          origin: "mock",
        };
      }
      if (mode === "echo") {
        return {
          translation: chunk,
          detectedLanguage: "ar",
          raw: { translation: chunk, detected_language: "ar" },
          usage: {},
          model: "fake",
          origin: "mock",
        };
      }
      if (mode === "wrong_lang") {
        return {
          translation: "هذا نص عربي طويل جدا وليس انجليزي بالمرة لمحاكاة فشل الفحص",
          detectedLanguage: "ar",
          raw: {
            translation: "هذا نص عربي طويل جدا وليس انجليزي بالمرة لمحاكاة فشل الفحص",
            detected_language: "ar",
          },
          usage: {},
          model: "fake",
          origin: "mock",
        };
      }
      if (mode === "refuse") {
        return {
          translation: "I cannot translate this content.",
          detectedLanguage: "en",
          raw: {
            translation: "I cannot translate this content.",
            detected_language: "en",
          },
          usage: {},
          model: "fake",
          origin: "mock",
        };
      }
      const translation = mockTranslateText(chunk);
      return {
        translation,
        detectedLanguage: "en",
        raw: { translation, detected_language: "en" },
        usage: { inputTokens: 10, outputTokens: 10, estimated: true },
        model: "fake-translate",
        origin: "mock",
      };
    },
  };
}
