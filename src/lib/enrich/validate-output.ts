import { z } from "zod";
import { isKnownTopic } from "./topics";

export type SentimentLabel = "positive" | "negative" | "neutral" | "mixed";

export class InvalidOutputError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`invalid output: ${reason}`);
    this.name = "InvalidOutputError";
    this.reason = reason;
  }
}

const sentimentSchema = z.object({
  choice: z.enum(["positive", "negative", "neutral", "mixed"]),
  confidence: z.number().min(0).max(1),
  probabilities: z
    .object({
      positive: z.number().min(0).max(1),
      negative: z.number().min(0).max(1),
      neutral: z.number().min(0).max(1),
      mixed: z.number().min(0).max(1),
    })
    .optional(),
});

const summaryTopicsSchema = z.object({
  summary: z.string().min(1).max(2000),
  summary_confidence: z.number().min(0).max(1),
  topics: z
    .array(
      z.object({
        name: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(1)
    .max(3),
});

export type ValidatedSentiment = z.infer<typeof sentimentSchema>;
export type ValidatedSummaryTopics = z.infer<typeof summaryTopicsSchema>;

export function validateSentimentOutput(raw: unknown):
  | { ok: true; value: ValidatedSentiment }
  | { ok: false; reason: string } {
  const parsed = sentimentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  if (parsed.data.probabilities) {
    const p = parsed.data.probabilities;
    const sum = p.positive + p.negative + p.neutral + p.mixed;
    if (Math.abs(sum - 1) > 0.05) return { ok: false, reason: "probabilities_sum" };
  }
  return { ok: true, value: parsed.data };
}

export function validateSummaryTopicsOutput(raw: unknown):
  | { ok: true; value: ValidatedSummaryTopics }
  | { ok: false; reason: string } {
  const parsed = summaryTopicsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  for (const t of parsed.data.topics) {
    if (!isKnownTopic(t.name)) return { ok: false, reason: "unknown_topic" };
  }
  // Reject if summary looks like raw HTML
  if (/<\s*script/i.test(parsed.data.summary)) return { ok: false, reason: "html_in_summary" };
  return { ok: true, value: parsed.data };
}
