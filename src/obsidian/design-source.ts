/**
 * ndomo obsidian — design source reader for `<projectDir>/.ndomo/designs/`.
 *
 * The original artifact created by `design_create` stays in the repo (auditable
 * record); this module resolves it so OBL-3 can project a normalized note into
 * `50-Designs` with `sourcePath` in the frontmatter.
 *
 * Safety:
 * - The caller input is reduced to a BASENAME (every `/` / `\` component —
 *   traversal included — is dropped), so `../../etc/passwd` degrades to the
 *   literal candidate `passwd` inside the designs dir and simply does not match.
 * - Candidates come from `readdirSync` (never from the input) and the resolved
 *   path is re-checked to be strictly inside the designs dir before reading.
 * - Directory entries are ignored (a folder named `x.md` cannot be read as a
 *   document) and a missing/empty designs dir yields `null` / `[]` — this
 *   function never throws on bad input (OBL-3 maps `null` → SOURCE_NOT_FOUND).
 *
 * Matching order (deterministic, first hit wins over a filename list sorted
 * lexicographically):
 *   1. exact filename (with or without the `.md` extension);
 *   2. slug fallback: `<slug>.md`, `*-<slug>.md` or `*<slug>*` bounded by
 *      hyphens — covers the `YYYY-MM-DD-<slug>-design.md` shape of
 *      `design_create` and its numeric collision suffixes (`-2.md`).
 */

import { readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFileIfExists } from "./fs.ts";

/** Resolved (not created) designs directory of a project. */
function designsDir(projectDir: string): string {
  return resolve(projectDir, ".ndomo", "designs");
}

/** `.md` files directly inside `dir`, sorted; missing dir → `[]`. Never throws. */
function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Strict lexical containment: `target` must be a path strictly below `dir`. */
function isInsideDir(target: string, dir: string): boolean {
  const rel = relative(dir, target);
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** Step 1 — exact filename, tolerating a missing `.md` on the input. */
function matchFilename(files: readonly string[], base: string): string | null {
  const candidates = /\.md$/i.test(base) ? [base] : [`${base}.md`, base];
  for (const candidate of candidates) {
    const hit = files.find((file) => file === candidate);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Step 2 — slug fallback (see module docs). Input slug is compared verbatim. */
function matchSlug(files: readonly string[], slug: string): string | null {
  if (slug === "") return null;
  const hit = files.find((file) => {
    const stem = file.replace(/\.md$/i, "");
    return stem === slug || stem.endsWith(`-${slug}`) || stem.includes(`-${slug}-`);
  });
  return hit ?? null;
}

/** Resolved design document (raw source artifact). */
export type DesignSource = {
  /** Basename inside `.ndomo/designs/` (always ends in `.md`). */
  filename: string;
  /** Verbatim file contents. */
  content: string;
  /** Project-relative path: `.ndomo/designs/<filename>`. */
  sourcePath: string;
};

/**
 * Read a design document by filename or by slug.
 *
 * @param projectDir Absolute path to the project root.
 * @param filenameOrSlug `2026-09-25-my-slug-design.md`, `…-design` or `my-slug`.
 * @returns The source or `null` when nothing matches (or the input is unsafe).
 */
export function readDesignSource(projectDir: string, filenameOrSlug: string): DesignSource | null {
  const raw = typeof filenameOrSlug === "string" ? filenameOrSlug.trim() : "";
  if (raw === "") return null;

  // Basename only — directory components (and `..`) never reach the filesystem.
  const base = raw.split(/[/\\]/).pop() ?? "";
  if (base === "" || base === "." || base === "..") return null;
  const stem = base.replace(/\.md$/i, "");
  if (stem === "") return null;

  const dir = designsDir(projectDir);
  const files = listMarkdownFiles(dir);
  const filename = matchFilename(files, base) ?? matchSlug(files, stem);
  if (filename === null) return null;

  const target = resolve(dir, filename);
  if (!isInsideDir(target, dir)) return null;

  // ENOENT (file removed between readdir and read) degrades to "not found".
  const content = readFileIfExists(target);
  if (content === null) return null;

  return { filename, content, sourcePath: join(".ndomo", "designs", filename) };
}

/** All design filenames in `.ndomo/designs/`, sorted; missing dir → `[]`. */
export function listDesignFiles(projectDir: string): string[] {
  return listMarkdownFiles(designsDir(projectDir));
}
