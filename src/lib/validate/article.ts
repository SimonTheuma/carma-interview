import { z } from "zod";

export type Result<T> =
  | { ok: true; value: T; flags: string[] }
  | { ok: false; reasonCodes: string[]; fieldErrors?: Record<string, string> };

const PLACEHOLDERS = new Set(["null", "n/a", "none", "undefined"]);

function isPlaceholder(s: string): boolean {
  return PLACEHOLDERS.has(s.trim().toLowerCase());
}

const rawArticleSchema = z.object({
  id: z.union([z.string(), z.number()]),
  source: z.unknown(),
  published_at: z.unknown(),
  language: z.unknown().optional(),
  headline: z.unknown().optional(),
  body: z.unknown().optional(),
});

export type ValidatedArticle = {
  externalId: string;
  source: string;
  publishedAt: Date;
  language: string;
  headline: string | null;
  body: string | null;
  flags: string[];
  rawBytes: number;
};

export function validateArticle(raw: unknown, now = new Date()): Result<ValidatedArticle> {
  const flags: string[] = [];
  const parsed = rawArticleSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reasonCodes: ["payload_invalid"] };
  }
  const item = parsed.data;
  const jsonSize = Buffer.byteLength(JSON.stringify(item), "utf8");
  if (jsonSize > 1_048_576) {
    return { ok: false, reasonCodes: ["payload_too_large"] };
  }

  let externalId: string;
  if (typeof item.id === "number" && Number.isFinite(item.id)) {
    externalId = String(item.id);
  } else if (typeof item.id === "string" && item.id.trim() && item.id.length <= 128) {
    externalId = item.id.trim();
  } else {
    return { ok: false, reasonCodes: ["id_invalid"] };
  }

  if (typeof item.source !== "string" || !item.source.trim()) {
    return { ok: false, reasonCodes: ["source_missing"] };
  }
  const source = item.source.trim();
  if (source.length > 256 || isPlaceholder(source)) {
    return { ok: false, reasonCodes: ["source_placeholder"] };
  }

  if (typeof item.published_at !== "string" || !item.published_at) {
    return { ok: false, reasonCodes: ["published_at_missing"] };
  }
  const pubStr = item.published_at;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(pubStr)) {
    return { ok: false, reasonCodes: ["published_at_no_timezone"] };
  }
  const publishedAt = new Date(pubStr);
  if (Number.isNaN(publishedAt.getTime())) {
    return { ok: false, reasonCodes: ["published_at_invalid"] };
  }
  const min = new Date("1990-01-01T00:00:00Z");
  const max = new Date(now.getTime() + 24 * 3600_000);
  if (publishedAt < min) return { ok: false, reasonCodes: ["published_at_ancient"] };
  if (publishedAt > max) return { ok: false, reasonCodes: ["published_at_future"] };
  if (publishedAt > now) flags.push("published_at_skew");

  let language = "und";
  if (typeof item.language === "string" && item.language.trim()) {
    const lang = item.language.trim();
    if (/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(lang) && lang.length <= 35) {
      language = lang;
    } else {
      flags.push("language_malformed");
    }
  } else {
    flags.push("language_missing");
  }

  const headline = coerceText(item.headline, flags, "headline");
  const body = coerceText(item.body, flags, "body");

  if (headline === null && body === null) {
    return { ok: false, reasonCodes: ["no_text"] };
  }
  if (headline && headline.length > 1000) flags.push("headline_oversized");

  return {
    ok: true,
    value: {
      externalId,
      source,
      publishedAt,
      language,
      headline,
      body,
      flags,
      rawBytes: jsonSize,
    },
    flags,
  };
}

function coerceText(
  value: unknown,
  flags: string[],
  field: "headline" | "body",
): string | null {
  if (value === null || value === undefined) {
    flags.push(`${field}_missing`);
    return null;
  }
  if (typeof value !== "string") {
    flags.push(`${field}_missing`);
    return null;
  }
  const t = value.trim();
  if (!t || isPlaceholder(t)) {
    flags.push(`${field}_placeholder`);
    return null;
  }
  return value;
}
