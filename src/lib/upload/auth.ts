import type { AppConfig } from "../config";

export type AuthResult =
  | { ok: true }
  | { ok: false; reason: "upload_disabled"; status: 503 };

/** Optional leftover Authorization / x-upload-token headers (ignored; ADR-0037). */
export function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const alt = request.headers.get("x-upload-token");
  return alt?.trim() || null;
}

/** PoC: upload is open when enabled; shared token is not required (ADR-0037). */
export function authorizeUpload(config: AppConfig, _presented?: string | null): AuthResult {
  if (!config.upload.enabled) {
    return { ok: false, reason: "upload_disabled", status: 503 };
  }
  return { ok: true };
}
