import { renderPrometheus } from "@/lib/metrics";

export const dynamic = "force-dynamic";

export function GET() {
  return new Response(renderPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
