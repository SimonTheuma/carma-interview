import type { AppConfig } from "../config";

export type GateOk = {
  ok: true;
  items: unknown[];
  bytes: number;
  fileSha256?: string;
  displayName?: string;
};

export type GateErr = {
  ok: false;
  reason: string;
  status: number;
  message: string;
};

export type GateResult = GateOk | GateErr;

function maxDepth(value: unknown, depth = 0, limit = 8): boolean {
  if (depth > limit) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const el of value) {
      if (maxDepth(el, depth + 1, limit)) return true;
    }
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (maxDepth(v, depth + 1, limit)) return true;
  }
  return false;
}

export function sanitizeDisplayName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, 100);
  return cleaned || undefined;
}

/** Read request body with a hard byte cap; rejects when over. */
export async function readBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | GateErr> {
  const declared = request.headers.get("content-length");
  if (declared != null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      return {
        ok: false,
        reason: "file_too_large",
        status: 413,
        message: `File is larger than ${maxBytes} bytes`,
      };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        reason: "file_too_large",
        status: 413,
        message: `File is larger than ${maxBytes} bytes`,
      };
    }
    chunks.push(value);
  }

  if (total === 0) {
    return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

export function decodeStrictUtf8(bytes: Uint8Array): { ok: true; text: string } | GateErr {
  try {
    let start = 0;
    // Strip UTF-8 BOM
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      start = 3;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start));
    if (!text.trim()) {
      return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
    }
    return { ok: true, text };
  } catch {
    return {
      ok: false,
      reason: "invalid_encoding",
      status: 400,
      message: "File is not UTF-8, re-save as UTF-8",
    };
  }
}

export function parseArticlesJson(
  text: string,
  config: AppConfig,
): GateResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "invalid_json",
      status: 400,
      message: "Not valid JSON",
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: "not_an_array",
      status: 400,
      message: "Not a JSON array",
    };
  }
  if (parsed.length > config.upload.maxItems) {
    return {
      ok: false,
      reason: "too_many_items",
      status: 422,
      message: `File has more than ${config.upload.maxItems} articles`,
    };
  }
  if (maxDepth(parsed, 0, config.upload.maxDepth)) {
    return {
      ok: false,
      reason: "too_deep",
      status: 400,
      message: `JSON nesting deeper than ${config.upload.maxDepth}`,
    };
  }
  return {
    ok: true,
    items: parsed,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export async function gateRequest(
  request: Request,
  config: AppConfig,
): Promise<GateResult> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();

  if (ct.includes("multipart/form-data")) {
    const declared = request.headers.get("content-length");
    if (declared != null) {
      const n = Number(declared);
      if (Number.isFinite(n) && n > config.upload.maxBytes + 64_000) {
        return {
          ok: false,
          reason: "file_too_large",
          status: 413,
          message: `File is larger than ${config.upload.maxBytes} bytes`,
        };
      }
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
    }
    const files = form.getAll("file");
    if (files.length === 0) {
      return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
    }
    if (files.length > 1) {
      return {
        ok: false,
        reason: "unsupported_media_type",
        status: 415,
        message: "Only one file part is allowed",
      };
    }
    const file = files[0];
    if (!(file instanceof Blob)) {
      return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
    }
    if (file.size > config.upload.maxBytes) {
      return {
        ok: false,
        reason: "file_too_large",
        status: 413,
        message: `File is larger than ${config.upload.maxBytes} bytes`,
      };
    }
    if (file.size === 0) {
      return { ok: false, reason: "empty_file", status: 400, message: "Empty file" };
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const decoded = decodeStrictUtf8(buf);
    if (!decoded.ok) return decoded;
    const parsed = parseArticlesJson(decoded.text, config);
    if (!parsed.ok) return parsed;
    const name =
      typeof File !== "undefined" && file instanceof File
        ? sanitizeDisplayName(file.name)
        : undefined;
    return {
      ...parsed,
      bytes: buf.byteLength,
      ...(name !== undefined ? { displayName: name } : {}),
    };
  }

  if (ct.includes("application/json") || ct === "" || ct.includes("text/plain") || ct.includes("application/octet-stream")) {
    const raw = await readBodyCapped(request, config.upload.maxBytes);
    if (!raw.ok) return raw;
    const decoded = decodeStrictUtf8(raw.bytes);
    if (!decoded.ok) return decoded;
    return parseArticlesJson(decoded.text, config);
  }

  return {
    ok: false,
    reason: "unsupported_media_type",
    status: 415,
    message: "Use multipart/form-data with a file part, or application/json",
  };
}
