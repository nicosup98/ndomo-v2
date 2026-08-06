// ─── CORS Middleware ──────────────────────────────────────────────────────────
/**
 * Custom CORS middleware — no external deps.
 *
 * Uses onRequest (not onBeforeHandle) so the hook propagates across
 * Elysia .use() boundaries.
 *
 * Behavior:
 * - origins includes "*" → ACAO: *, credentials NOT allowed (security)
 * - Otherwise → echo request Origin if in allowed list, else no header
 * - Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
 * - Headers: Content-Type, Authorization, X-Opencode-Directory
 * - Max-Age: 86400
 * - OPTIONS preflight → 204
 */
import { Elysia } from "elysia";

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization, X-Opencode-Directory";
const MAX_AGE = "86400";

export function corsMiddleware(origins: string[]) {
  const allowAll = origins.includes("*");
  const originSet = new Set(origins);

  return new Elysia({ name: "cors" }).onRequest(({ request, set }) => {
    const origin = request.headers.get("Origin");

    // Determine allowed origin
    if (allowAll) {
      set.headers["Access-Control-Allow-Origin"] = "*";
    } else if (origin && originSet.has(origin)) {
      set.headers["Access-Control-Allow-Origin"] = origin;
      set.headers["Vary"] = "Origin";
    }

    // Common preflight headers
    set.headers["Access-Control-Allow-Methods"] = ALLOWED_METHODS;
    set.headers["Access-Control-Allow-Headers"] = ALLOWED_HEADERS;
    set.headers["Access-Control-Max-Age"] = MAX_AGE;

    // Only set credentials when NOT wildcard (browser rejects wildcard+credentials)
    if (!allowAll) {
      set.headers["Access-Control-Allow-Credentials"] = "true";
    }

    // Handle OPTIONS preflight
    if (request.method === "OPTIONS") {
      set.status = 204;
      return "";
    }
  });
}
