// ─── HTTP Basic Auth Middleware ───────────────────────────────────────────────
/**
 * HTTP Basic authentication middleware.
 *
 * Reads OPENCODE_SERVER_PASSWORD from env directly (not via HttpConfig).
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Uses onRequest so the hook propagates across Elysia .use() boundaries.
 * Exempts from auth:
 *   - /health                — liveness probe
 *   - /api/events            — SSE push (browser EventSource cannot send
 *                              Authorization headers; route is read-only —
 *                              no mutations accepted)
 *   - non-/api paths         — SPA static + history fallback
 *
 * Only /api/* (excluding /api/events) requires auth.
 *
 * Behavior:
 * - auth.required === false → skip entirely
 * - /health path → skip (always public)
 * - /api/events path → skip (read-only SSE — see rationale above)
 * - non-/api path (SPA) → skip (public — Vue SPA serves static + history fallback)
 * - Password unset/empty → 503 auth_not_configured
 * - Missing/malformed Authorization → 401 + WWW-Authenticate
 * - Wrong password → 401 + WWW-Authenticate
 * - Correct → continue (no return value)
 */
import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import type { HttpConfig } from "../config/schema.ts";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

export function httpBasicAuth(httpConfig: HttpConfig) {
  return new Elysia({ name: "http-basic-auth" }).onRequest(({ request, set }) => {
    // Skip if auth not required
    if (!httpConfig.auth.required) return;

    // Exempt /health — public liveness probe
    const url = new URL(request.url);
    if (url.pathname === "/health") return;

    // Exempt /api/events — SSE push channel. Browser EventSource cannot send
    // custom Authorization headers, so this endpoint MUST be open. The route
    // is read-only (no mutations) so it's safe to leave unauthenticated.
    if (url.pathname === "/api/events") return;

    // Exempt non-/api paths — SPA static assets + history fallback are public.
    // Auth gates only the JSON API surface (/api/*). Users browse the SPA freely,
    // then enter the password in the in-app AuthPrompt when fetching /api/*.
    if (!url.pathname.startsWith("/api/")) return;

    const password = process.env.OPENCODE_SERVER_PASSWORD;

    // Password not configured → 503
    if (!password) {
      set.status = 503;
      set.headers["WWW-Authenticate"] = 'Basic realm="ndomo"';
      return { error: "auth_not_configured", message: "set OPENCODE_SERVER_PASSWORD" };
    }

    const authHeader = request.headers.get("Authorization");

    // Missing or malformed header → 401
    if (!authHeader?.startsWith("Basic ")) {
      set.status = 401;
      set.headers["WWW-Authenticate"] = 'Basic realm="ndomo", charset="UTF-8"';
      return { error: "invalid_credentials" };
    }

    // Decode base64 — format is "user:pass"
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const colonIdx = decoded.indexOf(":");
    const providedPassword = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;

    // Timing-safe comparison
    if (!constantTimeEqual(providedPassword, password)) {
      set.status = 401;
      set.headers["WWW-Authenticate"] = 'Basic realm="ndomo", charset="UTF-8"';
      return { error: "invalid_credentials" };
    }

    // Auth success — continue to handler (return undefined = no short-circuit)
    return;
  });
}
