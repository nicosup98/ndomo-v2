// ─── HTTP Configuration Schema ────────────────────────────────────────────────
/**
 * HTTP server configuration for ndomo.
 * Loaded from environment variables with sensible defaults.
 *
 * Environment variables:
 * - NDOMO_HTTP_ENABLED: "false" to disable HTTP server (default: "true")
 * - NDOMO_HTTP_PORT: Port number (default: 4097)
 * - NDOMO_HTTP_CORS_ORIGINS: Comma-separated list of allowed origins (default: ["*"])
 * - NDOMO_HTTP_AUTH_REQUIRED: "false" to disable auth requirement (default: "true")
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HttpConfig = {
  enabled: boolean; // default false, env: NDOMO_HTTP_ENABLED
  port: number; // default 4097, env: NDOMO_HTTP_PORT
  cors: {
    origins: string[]; // default ['*'] in dev, [] in prod, env: NDOMO_HTTP_CORS_ORIGINS (comma-separated)
  };
  auth: {
    required: boolean; // default true
  };
};

// ─── JEV (TypeSafe AI) Configuration ──────────────────────────────────────────
/**
 * JEV (TypeSafe AI System One) classification config for the hybrid router.
 *
 * Every field is overridable per-field from the `jev` block of ndomo.json:
 * - enabled: "false" to disable JEV entirely (default: true)
 * - model: TypeSafe model identifier (default: "jev-latest")
 * - timeoutMs: per-request timeout applied via AbortSignal (default: 3000)
 *
 * The API key is NOT part of this config: it is read from the
 * TYPESAFE_API_KEY environment variable only (see src/orchestrator/jev.ts).
 * Without a key, JEV stays silently disabled and routing falls back to rules.
 */
export type JevConfig = {
  enabled: boolean;
  model: string;
  timeoutMs: number;
};

/**
 * Default JEV configuration.
 */
export const JEV_DEFAULTS: JevConfig = {
  enabled: true,
  model: "jev-latest",
  timeoutMs: 3000,
};

// ─── NdomoConfig Schema ───────────────────────────────────────────────────────
/**
 * Full ndomo configuration as read from ndomo.config.json / ndomo.json.
 * Preserves all fields from the JSON file (plugin routing, presets, etc.)
 * and adds the optional HTTP block.
 */
export type NdomoConfig = {
  $schema?: string;
  plugins?: string[];
  optionalPlugins?: string[];
  presets?: Record<
    string,
    Record<string, { model?: string; temperature?: number; reasoning_effort?: string }>
  >;
  http?: HttpConfig;
  jev?: JevConfig;
  [key: string]: unknown;
};

/**
 * Resolve the ndomo config directory path.
 * Honors XDG_CONFIG_HOME, defaults to ~/.config/opencode.
 */
export function resolveConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, "opencode");
  }
  return join(homedir(), ".config", "opencode");
}

/**
 * Resolve the path to ndomo.json in the config directory.
 * @param configDir - Optional override for config directory
 */
export function resolveNdomoJsonPath(configDir?: string): string {
  return join(configDir ?? resolveConfigDir(), "ndomo.json");
}

/**
 * Load NdomoConfig from ndomo.json in the config directory.
 * Returns empty object if file is missing or unparseable.
 *
 * @param configPath - Optional explicit path to ndomo.json
 * @returns NdomoConfig with all fields from the file
 */
export function loadNdomoConfig(configPath?: string): NdomoConfig {
  const filePath = configPath ?? resolveNdomoJsonPath();
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as NdomoConfig;
    }
    return {};
  } catch {
    return {};
  }
}

// ─── Boolean env parsing helper ───────────────────────────────────────────────
function parseBoolEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (defaultValue === true) {
    // Default true: any value except "false" → true
    return value !== "false";
  }
  // Default false: only "true" → true
  return value === "true";
}

// ─── loadHttpConfig ───────────────────────────────────────────────────────────
/**
 * Load HTTP configuration with precedence: ndomo.json http block > env vars > defaults.
 *
 * If ndomo.json has a complete http block, use it.
 * If ndomo.json is missing OR http block is incomplete, fall back to env vars.
 * Env vars always override defaults (even when file has a partial block).
 *
 * @param configPath - Optional explicit path to ndomo.json
 * @returns HttpConfig with resolved values
 *
 * @example
 * // ndomo.json: { "http": { "enabled": true, "port": 8080, "cors": { "origins": ["a.com"] }, "auth": { "required": false } } }
 * const config = loadHttpConfig();
 * // config = { enabled: true, port: 8080, cors: { origins: ["a.com"] }, auth: { required: false } }
 *
 * @example
 * // No ndomo.json, env: NDOMO_HTTP_ENABLED=true
 * const config = loadHttpConfig();
 * // config = { enabled: true, port: 4097, cors: { origins: ["*"] }, auth: { required: true } }
 */
export function loadHttpConfig(configPath?: string): HttpConfig {
  const fileConfig = loadNdomoConfig(configPath);
  const http = fileConfig.http;

  // Helper: check if http block has all required fields (complete)
  const isCompleteHttp = (h: unknown): h is HttpConfig => {
    if (typeof h !== "object" || h === null) return false;
    const obj = h as Record<string, unknown>;
    return (
      typeof obj.enabled === "boolean" &&
      typeof obj.port === "number" &&
      typeof obj.cors === "object" &&
      obj.cors !== null &&
      Array.isArray((obj.cors as Record<string, unknown>).origins) &&
      typeof obj.auth === "object" &&
      obj.auth !== null &&
      typeof (obj.auth as Record<string, unknown>).required === "boolean"
    );
  };

  // If file has complete http block, use it (file > env)
  if (http && isCompleteHttp(http)) {
    return http;
  }

  // File missing or incomplete → fall back to env vars + defaults
  return {
    enabled: parseBoolEnv(process.env.NDOMO_HTTP_ENABLED, true),
    port: Number(process.env.NDOMO_HTTP_PORT) || 4097,
    cors: {
      origins: process.env.NDOMO_HTTP_CORS_ORIGINS?.split(",").map((s) => s.trim()) ?? ["*"],
    },
    auth: {
      required: parseBoolEnv(process.env.NDOMO_HTTP_AUTH_REQUIRED, true),
    },
  };
}

/**
 * Load JEV configuration with precedence: ndomo.json jev block > defaults.
 * Per-field resolution: invalid or missing fields fall back to defaults
 * individually, so a partial `jev` block is always safe.
 *
 * @param configPath - Optional explicit path to ndomo.json
 * @returns JevConfig with resolved values
 *
 * @example
 * // ndomo.json: { "jev": { "timeoutMs": 1500 } }
 * loadJevConfig();
 * // → { enabled: true, model: "jev-latest", timeoutMs: 1500 }
 */
export function loadJevConfig(configPath?: string): JevConfig {
  const fileConfig = loadNdomoConfig(configPath);
  const jev = fileConfig.jev;
  if (typeof jev !== "object" || jev === null || Array.isArray(jev)) {
    return { ...JEV_DEFAULTS };
  }
  const obj = jev as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : JEV_DEFAULTS.enabled,
    model:
      typeof obj.model === "string" && obj.model.trim().length > 0
        ? obj.model
        : JEV_DEFAULTS.model,
    timeoutMs:
      typeof obj.timeoutMs === "number" &&
      Number.isFinite(obj.timeoutMs) &&
      obj.timeoutMs > 0
        ? Math.floor(obj.timeoutMs)
        : JEV_DEFAULTS.timeoutMs,
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
