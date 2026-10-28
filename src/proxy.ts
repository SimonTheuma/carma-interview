import { NextRequest, NextResponse } from "next/server";

/** Build CSP value and nonce (exported for unit tests). No I/O (HP-D1). */
export function buildCsp(isDev = process.env.NODE_ENV === "development"): {
  nonce: string;
  csp: string;
} {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  return { nonce, csp };
}

/**
 * Per-request nonce CSP (ADR-0039).
 * No I/O — nonce generation and header assembly only (HP-D1).
 */
export function proxy(request: NextRequest) {
  const { nonce, csp } = buildCsp();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });
  response.headers.set("Content-Security-Policy", csp);
  // Echo nonce on the response for observability/tests (request also carries x-nonce).
  response.headers.set("x-nonce", nonce);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
