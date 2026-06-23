// ─── HTTP Configuration Schema ────────────────────────────────────────────────
/**
 * HTTP server configuration for ndomo.
 * Loaded from environment variables with sensible defaults.
 * 
 * Environment variables:
 * - NDOMO_HTTP_ENABLED: "true" to enable HTTP server (default: "false")
 * - NDOMO_HTTP_PORT: Port number (default: 4097)
 * - NDOMO_HTTP_CORS_ORIGINS: Comma-separated list of allowed origins (default: ["*"])
 * - NDOMO_HTTP_AUTH_REQUIRED: "false" to disable auth requirement (default: "true")
 */

export type HttpConfig = {
  enabled: boolean;  // default false, env: NDOMO_HTTP_ENABLED
  port: number;      // default 4097, env: NDOMO_HTTP_PORT
  cors: {
    origins: string[];  // default ['*'] in dev, [] in prod, env: NDOMO_HTTP_CORS_ORIGINS (comma-separated)
  };
  auth: {
    required: boolean;  // default true
  };
};

/**
 * Load HTTP configuration from environment variables with defaults.
 * 
 * @returns HttpConfig with values from environment or defaults
 * 
 * @example
 * // With env: NDOMO_HTTP_ENABLED=true, NDOMO_HTTP_PORT=8080
 * const config = loadHttpConfig();
 * // config = { enabled: true, port: 8080, cors: { origins: ["*"] }, auth: { required: true } }
 */
export function loadHttpConfig(): HttpConfig {
  return {
    enabled: process.env.NDOMO_HTTP_ENABLED === "true",
    port: Number(process.env.NDOMO_HTTP_PORT) || 4097,
    cors: {
      origins: process.env.NDOMO_HTTP_CORS_ORIGINS?.split(",").map(s => s.trim()) ?? ["*"],
    },
    auth: {
      required: process.env.NDOMO_HTTP_AUTH_REQUIRED !== "false",
    },
  };
}

/**
 * Security baseline headers for HTTP responses.
 * These headers should be applied to all HTTP responses to prevent common attacks.
 * 
 * @see https://owasp.org/www-project-secure-headers/
 */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

/**
 * Type for security headers object.
 */
export type SecurityHeaders = typeof SECURITY_HEADERS;
