export const VOCAB_VERSION = 1;

export const TOPIC_VOCABULARY = [
  "Energy",
  "Geopolitics",
  "Technology",
  "Artificial Intelligence",
  "Finance & Markets",
  "Economy & Central Banks",
  "Regulation & Policy",
  "Healthcare & Pharma",
  "Cybersecurity",
  "Climate & Environment",
  "Real Estate",
  "Automotive & Transport",
  "Travel & Aviation",
  "Sports",
  "Space",
  "Labour & Legal",
  "Agriculture & Commodities",
  "Consumer & Retail",
  "Other",
] as const;

export type Topic = (typeof TOPIC_VOCABULARY)[number];

export function isKnownTopic(value: string): value is Topic {
  return (TOPIC_VOCABULARY as readonly string[]).includes(value);
}
