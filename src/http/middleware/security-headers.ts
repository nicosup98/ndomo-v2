// ─── Security Headers Middleware ──────────────────────────────────────────────
/**
 * Applies OWASP security baseline headers to all HTTP responses.
 * Uses onRequest so headers propagate across Elysia .use() boundaries.
 * Adds X-Powered-By for server identification and HSTS in production.
 */
import { Elysia } from "elysia";
import { SECURITY_HEADERS } from "../../config/schema.ts";

export const securityHeaders = new Elysia({ name: "security-headers" }).onRequest(({ set }) => {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "X-Powered-By": "ndomo",
  };
  if (process.env.NODE_ENV === "production") {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  for (const [k, v] of Object.entries(headers)) {
    set.headers[k] = v;
  }
});
