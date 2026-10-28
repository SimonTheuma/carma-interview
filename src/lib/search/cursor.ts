import { createHmac, timingSafeEqual } from "node:crypto";

export type CursorPayload = {
  publishedAt: string;
  id: string;
  filterHash: string;
};

export function hashFilters(raw: string): string {
  return createHmac("sha256", "filter").update(raw).digest("hex").slice(0, 16);
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeCursor(token: string, secret: string): CursorPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    return null;
  }
}
