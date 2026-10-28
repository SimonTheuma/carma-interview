import { counter } from "@/lib/metrics";

export const dynamic = "force-dynamic";

const viewCounter = counter(
  "mss_translation_view_total",
  "Translation view toggles",
);
const dropped = counter("mss_ui_event_dropped_total", "UI telemetry events dropped");

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
const hits = new Map<string, { n: number; reset: number }>();

/** New values (ADR-0032 reveal) plus legacy for one release (Q6). */
const ACCEPTED = new Set([
  "original_shown",
  "original_hidden",
  "translated",
  "original",
]);

function rateLimit(ip: string): boolean {
  const now = Date.now();
  const cur = hits.get(ip);
  if (!cur || now > cur.reset) {
    hits.set(ip, { n: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (cur.n >= MAX_PER_WINDOW) return false;
  cur.n++;
  return true;
}

export async function POST(req: Request) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local";
  if (!rateLimit(ip)) {
    dropped.inc({ reason: "rate_limited", route: "translation-view" });
    return new Response(null, { status: 204 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    dropped.inc({ reason: "bad_json", route: "translation-view" });
    return new Response(null, { status: 204 });
  }

  const view =
    body && typeof body === "object" && "view" in body
      ? String((body as { view: unknown }).view)
      : null;
  if (!view || !ACCEPTED.has(view)) {
    dropped.inc({ reason: "bad_view", route: "translation-view" });
    return new Response(null, { status: 204 });
  }

  viewCounter.inc({ view });
  return new Response(null, { status: 204 });
}
