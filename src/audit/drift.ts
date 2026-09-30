/**
 * ndomo audit — frontmatter drift check (check a).
 *
 * Compares `agents/*.md` frontmatter against `config/ndomo.config.json`
 * `presets.<effective>` — the same source of truth `syncAgentFrontmatter()`
 * (src/plugin.ts) pushes from config → agent files at startup.
 *
 * Severities (documented rationale):
 * - `drift.field` (INFO) — frontmatter value differs from the preset for a key
 *   that exists on BOTH sides (`model`, `temperature`, `reasoningEffort` ←
 *   `reasoning_effort`). INFO because the preset always wins: the next sync
 *   rewrites the file, so this is transient staleness, not a defect. Only keys
 *   present on both sides are compared — an absent frontmatter key is not a
 *   drift (the file simply hasn't been synced yet).
 * - `drift.missing-file` (WARN) — preset declares an agent with no `agents/<id>.md`.
 *   Install/sync would warn and skip it: the agent silently disappears.
 * - `drift.missing-preset` (WARN) — `agents/<id>.md` exists but no preset entry:
 *   the agent never gets its model/temperature pinned (falls back to whatever
 *   the file says, forever).
 *
 * Coverage (`missing-file` / `missing-preset`) is evaluated for EVERY preset
 * (`default` and `budget`); value drift only for the EFFECTIVE preset, since
 * that is the one `syncAgentFrontmatter` applies.
 *
 * Deterministic: agent ids are sorted; no clock, no I/O beyond reads.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import type { Finding } from "./types.ts";

/** A preset entry: the three fields mirrored into agent frontmatter. */
export interface PresetSpec {
  model?: string | undefined;
  temperature?: number | undefined;
  reasoning_effort?: string | undefined;
}

/** Preset name → agent id → spec. Mirrors `NdomoConfig["presets"]`. */
export type Presets = Record<string, Record<string, PresetSpec>>;

/** Field mapping: preset key → frontmatter key (camelCase for effort). */
const FIELD_MAP: ReadonlyArray<{ preset: keyof PresetSpec; frontmatter: string }> = [
  { preset: "model", frontmatter: "model" },
  { preset: "temperature", frontmatter: "temperature" },
  { preset: "reasoning_effort", frontmatter: "reasoningEffort" },
] as const;

/** Sorted list of `agents/*.md` basenames (no extension). */
export function listAgentIds(projectDir: string): string[] {
  const dir = join(projectDir, "agents");
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/** Coerce `config.presets` into {@link Presets}; `null` when unusable. */
function asPresets(raw: unknown): Presets | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Presets;
}

/**
 * Format a value for comparison: temperatures compare numerically so `0.30`
 * equals `0.3`; everything else is a trimmed string.
 */
function normalize(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.trim();
  return null;
}

/**
 * Run the drift check.
 *
 * @param projectDir repo root (contains `agents/` and `config/ndomo.config.json`)
 * @param config     parsed config (from `checkConfig`); `null` skips the check
 * @param effectivePreset preset name the runtime will sync from
 */
export function checkDrift(
  projectDir: string,
  config: Record<string, unknown> | null,
  effectivePreset: string,
): Finding[] {
  const findings: Finding[] = [];
  const presets = asPresets(config?.presets);
  if (presets === null) return findings; // config invalid → already reported

  const agentIds = listAgentIds(projectDir);

  // 1) Coverage: every preset × every agent (WARN).
  for (const presetName of Object.keys(presets).sort()) {
    const preset = presets[presetName] ?? {};
    const presetIds = Object.keys(preset).sort();
    for (const id of presetIds) {
      if (!agentIds.includes(id)) {
        findings.push({
          code: "drift.missing-file",
          severity: "WARN",
          path: "config/ndomo.config.json",
          message: `preset "${presetName}" declares agent "${id}" but agents/${id}.md does not exist`,
          detail: { preset: presetName, agent: id },
        });
      }
    }
    for (const id of agentIds) {
      if (!presetIds.includes(id)) {
        findings.push({
          code: "drift.missing-preset",
          severity: "WARN",
          path: `agents/${id}.md`,
          message: `no entry for agent "${id}" in preset "${presetName}" (model/temperature never pinned)`,
          detail: { preset: presetName, agent: id },
        });
      }
    }
  }

  // 2) Value drift vs the effective preset (INFO) — intersection of keys only.
  const effective = presets[effectivePreset];
  if (!effective) {
    findings.push({
      code: "drift.missing-preset",
      severity: "WARN",
      path: "config/ndomo.config.json",
      message: `effective preset "${effectivePreset}" not found in config.presets`,
      detail: { preset: effectivePreset },
    });
    return findings;
  }

  for (const id of agentIds) {
    const spec = effective[id];
    if (!spec) continue; // coverage already reported above
    let raw: string;
    try {
      raw = readFileSync(join(projectDir, "agents", `${id}.md`), "utf-8");
    } catch {
      continue; // unreadable file → permission/manifest checks surface it
    }
    const fm = parseFrontmatter(raw);
    if (!fm.present) continue;

    for (const field of FIELD_MAP) {
      const presetRaw = spec[field.preset];
      if (presetRaw === undefined || presetRaw === null) continue;
      const fmValue = fm.scalars[field.frontmatter];
      if (fmValue === undefined) continue; // present on BOTH sides only
      const presetValue = normalize(presetRaw);
      const fmNormalized = normalize(fmValue);
      if (presetValue === null || fmNormalized === null) continue;
      if (presetValue === fmNormalized) continue;
      findings.push({
        code: "drift.field",
        severity: "INFO",
        path: `agents/${id}.md`,
        message: `${field.frontmatter}: frontmatter "${fmNormalized}" ≠ preset "${presetValue}" (preset wins on sync)`,
        detail: {
          agent: id,
          field: field.frontmatter,
          frontmatter: fmNormalized,
          preset: presetValue,
        },
      });
    }
  }

  return findings;
}
