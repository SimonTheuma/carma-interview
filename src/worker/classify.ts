import { InvalidOutputError } from "../lib/enrich/validate-output";

export type FailureClass = "transient" | "invalid_output" | "permanent";

export function classifyProviderError(err: unknown): FailureClass {
  if (err instanceof InvalidOutputError) return "invalid_output";
  if (!(err instanceof Error)) return "transient";
  const status = (err as Error & { status?: number }).status;
  const msg = err.message.toLowerCase();
  const code = (err as Error & { code?: string }).code;
  if (
    msg.includes("invalid output") ||
    msg.includes("unknown_topic") ||
    code === "invalid_output" ||
    msg.startsWith("out_") ||
    code?.startsWith("out_")
  ) {
    return "invalid_output";
  }
  if (status === 401 || status === 403 || status === 400) return "permanent";
  if (status && status >= 500) return "transient";
  if (msg.includes("abort") || msg.includes("timeout") || msg.includes("econn")) return "transient";
  if (status && status >= 400 && status < 500) return "permanent";
  return "transient";
}

/** Short, safe string for enrichment_jobs.last_error (no request body / keys). */
export function formatLastError(err: unknown): string {
  if (err instanceof InvalidOutputError) {
    return `invalid_output:${err.reason}`.slice(0, 500);
  }
  if (err instanceof Error) {
    const status = (err as Error & { status?: number }).status;
    const name = err.name || "Error";
    if (status !== undefined) return `${name}:status=${status}`.slice(0, 500);
    // Prefer class name + first clause of message, strip long payloads
    const brief = err.message.split(/[\n{]/)[0]!.trim().slice(0, 200);
    return `${name}:${brief}`.slice(0, 500);
  }
  return String(err).slice(0, 500);
}
