/**
 * ndomo obsidian — pure path builders + inside-repo guard.
 *
 * Everything here is deterministic and side-effect free with one documented
 * exception: {@link isInsideRepo} calls `realpathSync.native` (read-only,
 * best-effort) to defeat symlink escapes. {@link ensureVaultRoot} is the only
 * function that writes (mkdir of the vault root).
 *
 * Traversal safety: every dynamic segment goes through {@link sanitizeSegment},
 * so `..`, `/`, `\` and friends can never escape `Projects/<tag>/…`.
 *
 * Pattern mirrors src/db/designs.ts + src/db/ledgers.ts (DB-free helpers).
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome } from "../mem/store.ts";
import type { ObsidianConfig, ObsidianKind } from "./types.ts";

// ─── Folder topology ─────────────────────────────────────────────────────────

/** Root namespace for every project: `<vaultRoot>/Projects/<tag>/`. */
export const PROJECTS_FOLDER = "Projects";

/** All plan notes live here (index/roadmap), regardless of kind. */
export const PLANS_FOLDER = "10-Plans";

/** Dedicated folder for memory notes (deliberate exception to kind→folder). */
export const MEMORIES_FOLDER = "95-Memories";

/** Design notes always land here (source artifact stays in `.ndomo/designs/`). */
export const DESIGNS_FOLDER = "50-Designs";

/** Kind → task-note folder. Exhaustive over {@link ObsidianKind}. */
export const FOLDER_BY_KIND: Record<ObsidianKind, string> = {
  feature: "20-Features",
  bugfix: "30-Bugfixes",
  infra: "40-Infra",
  design: "50-Designs",
  docs: "70-Docs",
  refactor: "60-Refactors",
  research: "80-Research",
  other: "90-Other",
};

// ─── Sanitizers ──────────────────────────────────────────────────────────────

/** Any run outside `[a-z0-9]` collapses to a single `-` (traversal chars included). */
const UNSAFE_SEGMENT_RE = /[^a-z0-9]+/g;
const ACCENT_RE = /[\u0300-\u036f]/g;

/** Fallback segment when the input sanitizes to nothing. */
const FALLBACK_SEGMENT = "untitled";

/**
 * Traversal-safe single path segment (kebab-case, lowercase, ASCII).
 *
 * Removes `/` and `\`, collapses `..` and every other non-`[a-z0-9]` run to a
 * single hyphen, strips accents and trims edge hyphens. Underscores are NOT
 * preserved (kebab-case), so `ndomo_project_<hash>` → `ndomo-project-<hash>`;
 * the same rule is applied to the vault namespace AND to sync-state so both
 * sides always agree. Returns `"untitled"` when nothing survives.
 */
export function sanitizeSegment(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(ACCENT_RE, "")
    .toLowerCase()
    .replace(/[/\\]/g, "-")
    .replace(UNSAFE_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? FALLBACK_SEGMENT : slug;
}

/**
 * Kebab slug for free-form text (memory content), limited to `maxWords`
 * whitespace-separated words before sanitizing. Traversal-safe by delegation
 * to {@link sanitizeSegment}; falls back to `untitled`.
 */
export function slugify(input: string, maxWords = 6): string {
  const words = input
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, Math.max(1, maxWords));
  return sanitizeSegment(words.join(" "));
}

// ─── Vault root ──────────────────────────────────────────────────────────────

/**
 * Resolve the absolute vault root from `config.vaultPath` (`~/` expanded).
 * Pure: does NOT create anything on disk — use {@link ensureVaultRoot} before
 * writing. Precondition (assumed by callers, enforced here): `vaultPath` is a
 * non-empty string; OBL-3 maps this TypeError to the NOT_CONFIGURED envelope.
 */
export function resolveVaultRoot(config: Pick<ObsidianConfig, "vaultPath">): string {
  const raw = config.vaultPath.trim();
  if (raw === "") {
    throw new TypeError("ndomo: obsidian vaultPath is required (obsidian config block)");
  }
  return resolve(expandHome(raw));
}

/**
 * Resolve the vault root and create it (recursive) when missing.
 * `created` distinguishes a fresh materialization from an existing dir.
 */
export function ensureVaultRoot(config: Pick<ObsidianConfig, "vaultPath">): {
  root: string;
  created: boolean;
} {
  const root = resolveVaultRoot(config);
  const created = !existsSync(root);
  if (created) mkdirSync(root, { recursive: true });
  return { root, created };
}

// ─── Inside-repo guard ───────────────────────────────────────────────────────

/** True when `target` equals `base` or lives below it (lexical, case-sensitive). */
function isLexicallyInside(target: string, base: string): boolean {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Realpath comparison; `null` when either side cannot be canonicalized. */
function isRealpathInside(vaultRoot: string, projectDir: string): boolean | null {
  try {
    const realVault = realpathSync.native(vaultRoot);
    const realProject = realpathSync.native(projectDir);
    return isLexicallyInside(realVault, realProject);
  } catch {
    return null;
  }
}

/**
 * Guard: is the vault inside the project repo? Config-only (no per-call bypass).
 *
 * Lexical `path.relative` check UNIONED with a best-effort `realpath` check so
 * a symlink pointing into the repo is caught even when the path looks external.
 * If either realpath fails (e.g. vault not created yet) only the lexical signal
 * is used. Case-sensitive comparison (POSIX).
 */
export function isInsideRepo(vaultRoot: string, projectDir: string): boolean {
  if (isLexicallyInside(vaultRoot, projectDir)) return true;
  return isRealpathInside(vaultRoot, projectDir) === true;
}

/** Guard verdict mapped by OBL-3 to the INSIDE_REPO / UNSAFE_PATH envelopes. */
export type VaultGuardResult =
  | { ok: true }
  | { ok: false; code: "INSIDE_REPO" | "UNSAFE_PATH"; message: string };

/**
 * Shape guard for the CONFIGURED `vaultPath`, to run BEFORE
 * {@link resolveVaultRoot}. Returns the rejection reason, or `null` when safe.
 *
 * `resolveVaultRoot` deliberately anchors a relative path to `process.cwd()`
 * (documented and unit-tested), so feeding its OUTPUT to {@link checkVaultGuard}
 * would make that function's `isAbsolute` branch dead code: a caller typo such
 * as `"vault-rel"` would silently materialize a vault inside the repo checkout
 * instead of being rejected. Validating the configured string keeps the
 * UNSAFE_PATH answer reachable.
 *
 * An empty/whitespace value reports `null`: the executors answer
 * `NOT_CONFIGURED` for it before any path handling runs.
 */
export function vaultPathShapeError(vaultPath: string): string | null {
  const raw = vaultPath.trim();
  if (raw === "") return null;
  return isAbsolute(expandHome(raw)) ? null : `obsidian vaultPath must be absolute (got "${raw}")`;
}

/**
 * Validate a vault root against the project dir.
 * Order matters: a non-absolute `vaultRoot` is UNSAFE_PATH first (relative
 * paths would make the inside-repo answer meaningless), then the inside-repo
 * check, which `allowInsideRepo` (config-only) can waive.
 *
 * Defense-in-depth note: in the tool flows this first branch is unreachable —
 * `vaultPathShapeError` rejects non-absolute CONFIGURED paths before
 * `resolveVaultRoot` absolutizes anything. It stays as a guard for direct
 * callers (and would become live again if `resolveVaultRoot` ever stops
 * calling `resolve`).
 */
export function checkVaultGuard(
  vaultRoot: string,
  projectDir: string,
  allowInsideRepo: boolean,
): VaultGuardResult {
  if (!isAbsolute(vaultRoot)) {
    return {
      ok: false,
      code: "UNSAFE_PATH",
      message: `obsidian vaultPath must be absolute (got "${vaultRoot}")`,
    };
  }
  if (!allowInsideRepo && isInsideRepo(vaultRoot, projectDir)) {
    return {
      ok: false,
      code: "INSIDE_REPO",
      message: `obsidian vaultPath is inside the project repo (${vaultRoot})`,
    };
  }
  return { ok: true };
}

// ─── Namespace + note builders ───────────────────────────────────────────────

/** `<vaultRoot>/Projects/<sanitized tag>` — root of one project's notes. */
export function projectRoot(vaultRoot: string, projectTag: string): string {
  return join(vaultRoot, PROJECTS_FOLDER, sanitizeSegment(projectTag));
}

/** Plan note: `Projects/<tag>/10-Plans/<plan-slug>.md`. */
export function planNotePath(vaultRoot: string, projectTag: string, planSlug: string): string {
  return join(projectRoot(vaultRoot, projectTag), PLANS_FOLDER, `${sanitizeSegment(planSlug)}.md`);
}

/** First `8` chars of a sanitized id — short, stable, collision-resistant enough. */
function idFragment(id: string): string {
  const clean = sanitizeSegment(id);
  return clean.length > 8 ? clean.slice(0, 8) : clean;
}

/** `NN` = zero-padded floor of the 0-based `orderIndex` (`0` → `00`, `9` → `09`). */
function orderTag(orderIndex: number): string {
  return String(Math.floor(orderIndex)).padStart(2, "0");
}

/**
 * Task note: `Projects/<tag>/<kind folder>/<plan-slug>__t<NN>-<taskId8>.md`.
 * The `__` + `tNN` + id8 shape keeps tasks sortable and re-exportable when the
 * plan slug changes (path stability: sync-state owns the authoritative path).
 */
export function taskNotePath(
  vaultRoot: string,
  projectTag: string,
  kind: ObsidianKind,
  planSlug: string,
  orderIndex: number,
  taskId: string,
): string {
  const folder = FOLDER_BY_KIND[kind];
  const file = `${sanitizeSegment(planSlug)}__t${orderTag(orderIndex)}-${idFragment(taskId)}.md`;
  return join(projectRoot(vaultRoot, projectTag), folder, file);
}

/**
 * Design note: `Projects/<tag>/50-Designs/<sanitized source filename>.md`.
 * Only the basename is used (any directory part is dropped) and the `.md`
 * extension is re-appended after sanitizing, so the source stays recognizable.
 */
export function designNotePath(
  vaultRoot: string,
  projectTag: string,
  sourceFilename: string,
): string {
  const base = sourceFilename.split(/[/\\]/).pop() ?? "";
  const stem = base.replace(/\.md$/i, "");
  return join(projectRoot(vaultRoot, projectTag), DESIGNS_FOLDER, `${sanitizeSegment(stem)}.md`);
}

/**
 * Memory note: `Projects/<tag>/95-Memories/<content-slug(6)>__<id8>.md`.
 * Content slug is capped at 6 words to keep filenames readable.
 */
export function memoryNotePath(
  vaultRoot: string,
  projectTag: string,
  content: string,
  memoryId: string,
): string {
  const file = `${slugify(content, 6)}__${idFragment(memoryId)}.md`;
  return join(projectRoot(vaultRoot, projectTag), MEMORIES_FOLDER, file);
}

/** Vault-relative POSIX path (always `/`, even for absolute inputs). */
export function toVaultRelative(vaultRoot: string, absPath: string): string {
  return relative(resolve(vaultRoot), resolve(absPath)).split(sep).join("/");
}
