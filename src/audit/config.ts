/**
 * ndomo audit — config check (check d).
 *
 * Validates `config/ndomo.config.json` (the file shipped in this repo; the
 * installed copy lives at `~/.config/opencode/ndomo.json` — same schema):
 *
 * 1. JSON parses.
 * 2. Top-level keys are known.
 *
 * Known keys = union of the two runtime types that actually read the file:
 * - `NdomoConfig` in `src/plugin.ts` (agentRouting/protectedTools/caveman/
 *   presets/dcp_overrides/mem/circuitBreaker/autoCheckpoint/…
 * - `NdomoConfig` in `src/config/schema.ts` (the loader used by JEV/Obsidian:
 *   `$schema`/`plugins`/`optionalPlugins`/`presets`/`jev`/`obsidian`)
 * plus `$schema`, which the JSON-Schema validator consumes.
 *
 * The union is intentionally exhaustive-but-static: a new key must be added
 * here deliberately (that is the point of the check — silently ignored config
 * keys are a drift class of their own).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./types.ts";

/** File name inside `<projectDir>/config/`. */
export const CONFIG_FILE = "ndomo.config.json";

/**
 * Top-level keys understood by the runtime (see module docstring).
 * Keep in sync with `NdomoConfig` (src/plugin.ts) + `NdomoConfig` (src/config/schema.ts).
 */
export const KNOWN_CONFIG_KEYS: readonly string[] = [
  "$schema",
  "autoCheckpoint",
  "backgroundRetention",
  "caveman",
  "circuitBreaker",
  "dcp_overrides",
  "fileLock",
  "jev",
  "mem",
  "obsidian",
  "optionalPlugins",
  "plugins",
  "preset",
  "presets",
  "protectedTools",
  "agentRouting",
] as const;

/** Result of loading + validating the project config file. */
export interface ConfigCheckResult {
  findings: Finding[];
  /** Parsed config when valid, else `null`. Drift checks need `presets`. */
  config: Record<string, unknown> | null;
}

/**
 * Run the config check against `<projectDir>/config/ndomo.config.json`.
 * Missing file → a single `config.invalid-json` ERROR (the repo ships one).
 */
export function checkConfig(projectDir: string): ConfigCheckResult {
  const rel = `config/${CONFIG_FILE}`;
  const abs = join(projectDir, "config", CONFIG_FILE);
  const findings: Finding[] = [];

  if (!existsSync(abs)) {
    findings.push({
      code: "config.invalid-json",
      severity: "ERROR",
      path: rel,
      message: `config file not found: ${rel}`,
    });
    return { findings, config: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf-8"));
  } catch (err) {
    findings.push({
      code: "config.invalid-json",
      severity: "ERROR",
      path: rel,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { findings, config: null };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    findings.push({
      code: "config.invalid-json",
      severity: "ERROR",
      path: rel,
      message: "config root must be a JSON object",
    });
    return { findings, config: null };
  }

  const config = parsed as Record<string, unknown>;
  const known = new Set(KNOWN_CONFIG_KEYS);
  for (const key of Object.keys(config).sort()) {
    if (!known.has(key)) {
      findings.push({
        code: "config.unknown-key",
        severity: "WARN",
        path: rel,
        message: `unknown top-level key "${key}" (ignored by the runtime)`,
        detail: { key },
      });
    }
  }

  return { findings, config };
}
