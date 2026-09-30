/**
 * ndomo audit — sha256 manifest (check e).
 *
 * Tracks the content hash of every file the audit cares about:
 *   - `agents/*.md`
 *   - every file under `skills/` (recursive, sorted)
 *   - `config/ndomo.config.json`
 *   - `config/ndomo.schema.json`
 *
 * and stores them at `<projectDir>/.ndomo/audit/manifest.json` (POSIX-relative
 * keys, sorted → byte-stable JSON).
 *
 * Diffing the freshly computed map against the stored one yields regression
 * findings:
 * - `manifest.modified` **WARN** — a tracked file changed since the baseline.
 *   Changed agent/skill/config content is exactly the class of regression the
 *   manifest exists to catch (unreviewed edits).
 * - `manifest.added` **INFO** — a new file appeared (new agent/skill, expected
 *   during development; re-baseline with `updateManifest: true`).
 * - `manifest.removed` **WARN** — a baseline file vanished (deletion is harder
 *   to notice than an edit and can break references).
 * - `manifest.first-run` **INFO** — no baseline yet; nothing to compare.
 *
 * Writes happen ONLY when `updateManifest: true` (re-baseline); otherwise this
 * module is pure read + hash. That keeps `runAudit` report-only by default.
 *
 * Hashing reuses `sha256Hex` from `src/obsidian/fs.ts` (64-char lowercase
 * SHA-256 of UTF-8 content) rather than duplicating crypto code.
 */

import { readdirSync, readFileSync, type Stats, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ensureDir, sha256Hex } from "../obsidian/fs.ts";
import type { Finding, ManifestOutcome } from "./types.ts";

/** Manifest file location relative to `projectDir`. */
export const MANIFEST_REL_PATH = ".ndomo/audit/manifest.json";

/** Manifest schema version (bump on format changes). */
const MANIFEST_VERSION = 1;

/** Stored manifest shape. */
export interface Manifest {
  version: number;
  /** Relative POSIX path → sha256 hex (sorted on write). */
  files: Record<string, string>;
}

/** Freshly computed manifest + write outcome. */
export interface ManifestResult {
  manifest: Manifest;
  outcome: ManifestOutcome;
  /** Diff findings (baseline missing/modified/added/removed). */
  findings: Finding[];
}

/** Normalize an absolute path to a project-relative POSIX key. */
function toKey(projectDir: string, absolute: string): string {
  return relative(projectDir, absolute).split(sep).join("/");
}

/** Recursive, sorted list of every regular file under `dir`. */
function walkFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statOrNull(full);
    if (stat === null) continue;
    if (stat.isDirectory()) files.push(...walkFiles(full));
    else if (stat.isFile()) files.push(full);
  }
  return files;
}

/** `statSync` that returns `null` instead of throwing (race/permissions). */
function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Build the current manifest for a project (sorted keys, no I/O besides reads). */
export function computeManifest(projectDir: string): Manifest {
  const files: Record<string, string> = {};

  const agentsDir = join(projectDir, "agents");
  for (const name of readdirSafe(agentsDir).sort()) {
    if (!name.endsWith(".md")) continue;
    addHash(projectDir, join(agentsDir, name), files);
  }
  for (const absolute of walkFiles(join(projectDir, "skills")).sort()) {
    addHash(projectDir, absolute, files);
  }
  for (const name of ["ndomo.config.json", "ndomo.schema.json"]) {
    addHash(projectDir, join(projectDir, "config", name), files);
  }

  return { version: MANIFEST_VERSION, files: sortRecord(files) };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function addHash(projectDir: string, absolute: string, into: Record<string, string>): void {
  try {
    // Tracked files are text (`*.md`, `*.json`, `*.sh`, `*.txt`), so hashing
    // the UTF-8 decode matches `sha256Hex`'s contract. A future binary asset
    // under skills/ would need a byte-wise hash instead.
    const raw = readFileSync(absolute, "utf-8");
    into[toKey(projectDir, absolute)] = sha256Hex(raw);
  } catch {
    // Unreadable file: omit rather than hash nothing — permission checks cover
    // missing agents, manifest diffs cover vanished ones.
  }
}

function sortRecord(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input).sort()) out[key] = input[key] as string;
  return out;
}

/** Read the stored manifest; `null` when absent or unparsable. */
export function readManifest(projectDir: string): Manifest | null {
  let raw: string;
  try {
    raw = readFileSync(join(projectDir, MANIFEST_REL_PATH), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const files = (parsed as { files?: unknown }).files;
    if (typeof files !== "object" || files === null || Array.isArray(files)) return null;
    const version = (parsed as { version?: unknown }).version;
    return {
      version: typeof version === "number" ? version : 0,
      files: files as Record<string, string>,
    };
  } catch {
    return null;
  }
}

/** Write the manifest atomically-ish (mkdir -p + direct write, `.ndomo/audit/` only). */
export function writeManifest(projectDir: string, manifest: Manifest): void {
  const absolute = join(projectDir, MANIFEST_REL_PATH);
  ensureDir(join(projectDir, ".ndomo", "audit"));
  writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
}

/**
 * Compute the manifest, diff it against the stored baseline, and (only when
 * `updateManifest` is true) overwrite the baseline.
 *
 * @param updateManifest re-baseline when `true`; read-only when `false`
 */
export function checkManifest(projectDir: string, updateManifest: boolean): ManifestResult {
  const current = computeManifest(projectDir);
  const previous = readManifest(projectDir);
  const tracked = Object.keys(current.files).length;

  const findings: Finding[] = [];

  if (previous === null) {
    findings.push({
      code: "manifest.first-run",
      severity: "INFO",
      path: MANIFEST_REL_PATH,
      message: `no baseline manifest — ${tracked} files tracked (re-run with --update-manifest to baseline)`,
      detail: { tracked },
    });
  } else {
    const prevFiles = previous.files;
    for (const key of Object.keys(current.files).sort()) {
      const now = current.files[key] as string;
      const before = prevFiles[key];
      if (before === undefined) {
        findings.push({
          code: "manifest.added",
          severity: "INFO",
          path: key,
          message: `new file since baseline: ${key}`,
        });
      } else if (before !== now) {
        findings.push({
          code: "manifest.modified",
          severity: "WARN",
          path: key,
          message: `content changed since baseline: ${key}`,
        });
      }
    }
    for (const key of Object.keys(prevFiles).sort()) {
      if (current.files[key] !== undefined) continue;
      findings.push({
        code: "manifest.removed",
        severity: "WARN",
        path: key,
        message: `baseline file missing: ${key}`,
      });
    }
  }

  let written = false;
  if (updateManifest) {
    writeManifest(projectDir, current);
    written = true;
  }

  return {
    manifest: current,
    outcome: { path: MANIFEST_REL_PATH, baselineFound: previous !== null, written, tracked },
    findings,
  };
}
