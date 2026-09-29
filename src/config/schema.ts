import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Type-only import: src/obsidian/types.ts has zero runtime imports, so the
// loader and the projection layer never form a module cycle.
import type { ObsidianConfig } from "../obsidian/types.ts";

export type { ObsidianConfig };

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
 * Preserves all fields from the JSON file (plugin routing, presets, etc.).
 */
export type NdomoConfig = {
  $schema?: string;
  plugins?: string[];
  optionalPlugins?: string[];
  presets?: Record<
    string,
    Record<string, { model?: string; temperature?: number; reasoning_effort?: string }>
  >;
  jev?: JevConfig;
  /** Obsidian brain-layer projection (see {@link loadObsidianConfig}). */
  obsidian?: ObsidianConfig;
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
      typeof obj.model === "string" && obj.model.trim().length > 0 ? obj.model : JEV_DEFAULTS.model,
    timeoutMs:
      typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
        ? Math.floor(obj.timeoutMs)
        : JEV_DEFAULTS.timeoutMs,
  };
}

// ─── Obsidian (brain layer) Configuration ────────────────────────────────────
/**
 * Env fallback for the vault location. Lets tests / CI point the projection at
 * a tmp dir without writing a config file (design goal: `NDOMO_OBSIDIAN_VAULT_PATH`).
 */
const OBSIDIAN_VAULT_ENV = "NDOMO_OBSIDIAN_VAULT_PATH";

/**
 * Load the Obsidian projection config with PER-FIELD precedence (same style as
 * {@link loadJevConfig}), so a partial `obsidian` block is always safe:
 *
 * - `enabled`         → `file.obsidian.enabled` (boolean) else `true`
 * - `vaultPath`       → non-empty `file.obsidian.vaultPath` → `$NDOMO_OBSIDIAN_VAULT_PATH` → `""`
 * - `allowInsideRepo` → `file.obsidian.allowInsideRepo` (boolean) else `false`
 *
 * `vaultPath: ""` is the "not configured" state: the `obsidian_*` tools answer
 * with the `NOT_CONFIGURED` envelope instead of guessing a vault.
 *
 * @param configPath - Optional explicit path to ndomo.json
 * @returns ObsidianConfig with resolved values
 *
 * @example
 * // env: NDOMO_OBSIDIAN_VAULT_PATH=/tmp/vault
 * loadObsidianConfig();
 * // → { enabled: true, vaultPath: "/tmp/vault", allowInsideRepo: false }
 */
export function loadObsidianConfig(configPath?: string): ObsidianConfig {
  const fileConfig = loadNdomoConfig(configPath);
  const raw: unknown = fileConfig.obsidian;
  const obj: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  const fileVault = typeof obj.vaultPath === "string" ? obj.vaultPath.trim() : "";
  const envVault = (process.env[OBSIDIAN_VAULT_ENV] ?? "").trim();

  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : true,
    vaultPath: fileVault !== "" ? fileVault : envVault,
    allowInsideRepo: typeof obj.allowInsideRepo === "boolean" ? obj.allowInsideRepo : false,
  };
}
