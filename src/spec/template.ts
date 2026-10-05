/**
 * ndomo spec — canonical template, filesystem helpers and spec creation.
 *
 * Specs are DB-free file artifacts under `<projectDir>/.ndomo/specs/NNN-<slug>/spec.md`
 * (docs-as-code, versionable in git). This module mirrors the house pattern of
 * `src/db/designs.ts`: pure sanitizers/validators, a pure markdown builder and
 * a `create*` that writes atomically and never overwrites.
 *
 * Safety guarantees:
 *  - slug is sanitized to ASCII kebab-case (path-traversal-safe).
 *  - date is validated as strict YYYY-MM-DD (no `..` / separators).
 *  - `NNN` comes from `nextSpecIndex` (max existing + 1, never reused).
 *  - the slug is re-checked immediately before writing, and the final write
 *    uses the `wx` flag, so two concurrent `spec_create` calls can never
 *    produce a second dir for one slug or overwrite an existing spec.
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { scanFrontmatter } from "./parse.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One of the canonical `## N. Title` sections of a spec document. */
export interface SpecSectionDescriptor {
  number: number;
  title: string;
  /** L2 fires when a required section is missing. */
  required: boolean;
}

/** Input for {@link buildSpecTemplate}. Optional fields accept `undefined`. */
export interface SpecTemplateInput {
  index: number;
  slug: string;
  title?: string | undefined;
  date?: string | undefined;
  planId?: string | undefined;
  relatedDesigns?: string[] | undefined;
  /**
   * Frontmatter owner. Not part of the frozen contract surface — added so
   * `createSpec` can thread `input.agent` through without string surgery.
   */
  agent?: string | undefined;
}

/** Input for {@link createSpec}. */
export interface SpecCreateInput {
  slug: string;
  title?: string | undefined;
  planId?: string | undefined;
  sessionId?: string | undefined;
  agent?: string | undefined;
  date?: string | undefined;
}

/** Metadata returned after a spec file is written. */
export interface SpecCreateResult {
  id: string;
  slug: string;
  /** Absolute path to the written spec.md. */
  path: string;
  created: true;
  byteSize: number;
}

// ─── Canonical sections ──────────────────────────────────────────────────────

/**
 * The 13 canonical sections in numeric order (SPEC-001 §2 / REQ-001).
 * Required set for L2: 1–6, 11, 13. Optional: 7–10, 12.
 */
export const SPEC_SECTIONS: readonly SpecSectionDescriptor[] = [
  { number: 1, title: "Purpose", required: true },
  { number: 2, title: "Scope", required: true },
  { number: 3, title: "Non-goals", required: true },
  { number: 4, title: "Actors", required: true },
  { number: 5, title: "Requirements", required: true },
  { number: 6, title: "Acceptance Criteria", required: true },
  { number: 7, title: "Interfaces / Contracts", required: false },
  { number: 8, title: "Data Model", required: false },
  { number: 9, title: "Edge Cases", required: false },
  { number: 10, title: "NFRs", required: false },
  { number: 11, title: "Traceability", required: true },
  { number: 12, title: "Open Questions", required: false },
  { number: 13, title: "Changelog", required: true },
];

// ─── Validation & sanitization (pure) ────────────────────────────────────────

const SLUG_MAX_LENGTH = 80;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPEC_ID_RE = /^SPEC-\d{3}$/;

/**
 * Sanitize a slug to safe ASCII kebab-case for use in a directory name.
 * Strips anything outside [a-z0-9-], collapses runs, trims edges.
 * Defeats path traversal: `../etc` → `etc`, `a/../b` → `a-b`.
 */
export function sanitizeSpecSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

/**
 * Validate that a slug is usable. Throws on empty / whitespace-only /
 * post-sanitization-empty input. Returns the SANITIZED slug.
 */
export function validateSpecSlug(slug: string): string {
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error("ndomo: spec slug cannot be empty");
  }
  const clean = sanitizeSpecSlug(slug);
  if (clean.length === 0) {
    throw new Error(
      `ndomo: spec slug '${slug}' sanitizes to empty (needs at least one [a-z0-9] char)`,
    );
  }
  return clean;
}

/**
 * Validate a date string as strict YYYY-MM-DD with a real calendar date.
 * Throws on malformed format or impossible dates (e.g. 2026-13-45).
 * Returns the validated string unchanged.
 */
export function validateSpecDate(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) {
    throw new Error(`ndomo: spec date '${date}' must match YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Construct at noon UTC to sidestep DST edge cases, then verify round-trip.
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`ndomo: spec date '${date}' is not a valid calendar date`);
  }
  return date;
}

/** Current date as YYYY-MM-DD (UTC). */
function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─── Naming helpers ──────────────────────────────────────────────────────────

/** `SPEC-NNN` from a 1-based index (3-digit zero pad, unbounded above 999). */
export function buildSpecId(index: number): string {
  return `SPEC-${String(index).padStart(3, "0")}`;
}

/** `NNN-slug` directory name (3-digit zero pad). */
export function buildSpecDirName(index: number, slug: string): string {
  return `${String(index).padStart(3, "0")}-${slug}`;
}

/**
 * Derive a human title from a slug: `my-thing` → `My Thing`. A leading
 * `NNN-` directory prefix (3+ digits) is stripped first.
 */
export function deriveSpecTitle(slug: string): string {
  const bare = slug.replace(/^\d{3,}-/, "");
  return bare
    .split("-")
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** True when `value` is a syntactically valid, real YYYY-MM-DD date. */
export function isValidSpecDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** True when `value` matches the `SPEC-\d{3}` contract. */
export function isValidSpecId(value: string): boolean {
  return SPEC_ID_RE.test(value);
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

/**
 * Resolve the per-project specs directory.
 * Path: `<projectDir>/.ndomo/specs/`. Creates it if missing.
 */
export function resolveSpecsDir(projectDir: string): string {
  const dir = resolve(projectDir, ".ndomo", "specs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Non-creating view of the specs directory (reads must not mutate the FS). */
function specsDirOf(projectDir: string): string {
  return resolve(projectDir, ".ndomo", "specs");
}

/**
 * Next free spec index: max `NNN` prefix found in `dir` plus 1; 1 when the
 * directory is missing or empty. Reads are best-effort and never throw.
 */
export function nextSpecIndex(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    const m = /^(\d+)-/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** First `NNN-<slug>` dir for `slug` (sorted for determinism), or null. */
function findSpecDirBySlug(specsDir: string, slug: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(specsDir);
  } catch {
    return null;
  }
  for (const entry of [...entries].sort()) {
    const m = /^(\d+)-(.+)$/.exec(entry);
    if (m && m[2] === slug) return join(specsDir, entry);
  }
  return null;
}

/** True when `candidate` exists and is a directory (best-effort probe). */
function isDirectory(candidate: string): boolean {
  try {
    readdirSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function isReadableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && !isDirectory(candidate);
  } catch {
    return false;
  }
}

/**
 * Resolve a spec reference to an absolute spec.md path, or null when nothing
 * matches. Never throws.
 *
 * Accepted inputs (exact):
 *  - `"SPEC-001"` — scan `.ndomo/specs/<NNN-slug>/spec.md` frontmatter for that id;
 *  - `"001-sdd-core"` / `"001-sdd-core/spec.md"` — specs-dir relative;
 *  - a path relative to `projectDir`;
 *  - an absolute path.
 */
export function resolveSpecPath(projectDir: string, idOrPath: string): string | null {
  if (typeof idOrPath !== "string") return null;
  const input = idOrPath.trim();
  if (input.length === 0) return null;

  try {
    if (isAbsolute(input)) {
      if (isReadableFile(input)) return resolve(input);
      const nested = join(input, "spec.md");
      return isReadableFile(nested) ? resolve(nested) : null;
    }

    if (SPEC_ID_RE.test(input)) {
      const specsDir = specsDirOf(projectDir);
      let entries: string[];
      try {
        entries = readdirSync(specsDir);
      } catch {
        return null;
      }
      for (const entry of [...entries].sort()) {
        if (!/^\d+-/.test(entry)) continue;
        const file = join(specsDir, entry, "spec.md");
        if (!isReadableFile(file)) continue;
        try {
          const { values } = scanFrontmatter(readFileSync(file, "utf8"));
          if (values.id === input) return resolve(file);
        } catch {}
      }
      return null;
    }

    if (/^\d+-/.test(input)) {
      const specsDir = specsDirOf(projectDir);
      const candidate = input.endsWith("spec.md")
        ? join(specsDir, input)
        : join(specsDir, input, "spec.md");
      return isReadableFile(candidate) ? resolve(candidate) : null;
    }

    const candidate = resolve(projectDir, input);
    if (isReadableFile(candidate)) return resolve(candidate);
    const nested = join(candidate, "spec.md");
    return isReadableFile(nested) ? resolve(nested) : null;
  } catch {
    return null;
  }
}

// ─── Template (pure) ─────────────────────────────────────────────────────────

/** Guidance paragraph for a canonical section. */
function sectionBody(number: number): string {
  switch (number) {
    case 1:
      return '_Why this spec exists: the problem it solves, the value it delivers, and what "done" means._';
    case 2:
      return "_What is in scope: modules, tools, files and behaviors this spec covers._";
    case 3:
      return "_What is explicitly out of scope: rejected alternatives and deferred work._";
    case 4:
      return "_Who interacts with the feature and what each actor needs._";
    case 5:
      return [
        "_Requirements live here as `### REQ-NNN — Title` blocks; acceptance criteria nest under each requirement._",
        "_Fenced code blocks are ignored by the parser, so this example is safe to copy:_",
        "",
        "```markdown",
        "### REQ-001 — Example requirement",
        "",
        "WHEN <trigger>, THE system SHALL <behavior>.",
        "",
        "- AC-001-1: **Given** <precondition>, **When** <action>, **Then** <outcome>.",
        "- type: ubiq · priority: P1 · owner: unknown · status: active",
        "```",
        "",
        "_Meta bullets may also be written as separate `- **Type**: ...` bullets; `status` defaults to `active`._",
      ].join("\n");
    case 6:
      return "_One AC = one test tagged with its requirement id. ACs live nested under each requirement in section 5; this section documents the convention._";
    case 7:
      return "_Tools, contracts, metadata keys and CLI surfaces defined by this spec._";
    case 8:
      return '_Tables, fields, files involved — or "no schema changes"._';
    case 9:
      return "_Situations and the behavior required for each._";
    case 10:
      return "_Determinism, performance, i18n and adoption constraints._";
    case 11:
      return [
        "_One row per requirement × AC mapping to plan tasks and tests. Rows inside fenced blocks are documentation only:_",
        "",
        "```markdown",
        "| REQ | AC | Tasks | Tests | state |",
        "|---|---|---|---|---|",
        "| REQ-001 | AC-001-1 | <taskId> | <path/to/test.ts> | red |",
        "```",
      ].join("\n");
    case 12:
      return "_List open questions here. While `status` is `draft` or `in-review`, plain-text markers like [NEEDS CLARIFICATION: decide the transport] are tolerated; they must be resolved before status reaches `approved` (lint rule L4)._";
    case 13:
      return "- **<YYYY-MM-DD> v<version> (<author>)** — newest entries first.";
    default:
      return "";
  }
}

/**
 * Build the full canonical spec markdown for one spec. Pure: no I/O.
 *
 * Produces frontmatter with all 11 required keys and all 13 sections in
 * canonical order. Sections 5 and 11 carry their format examples inside
 * fenced code blocks, so a freshly created spec lints clean (L3/L6/L8 see no
 * requirements or matrix rows until a human writes real ones).
 */
export function buildSpecTemplate(input: SpecTemplateInput): string {
  if (!Number.isInteger(input.index) || input.index < 1) {
    throw new Error(`ndomo: spec index must be a positive integer (got ${String(input.index)})`);
  }
  const slug = validateSpecSlug(input.slug);
  const date = validateSpecDate(input.date ?? todayUtc());
  const title = (input.title ?? "").trim().replace(/\s+/g, " ") || deriveSpecTitle(slug);
  const owner = input.agent?.trim() || "unknown";
  const planId = input.planId?.trim() ?? "";
  const relatedDesigns = (input.relatedDesigns ?? [])
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const id = buildSpecId(input.index);

  const lines: string[] = [
    "---",
    `id: ${id}`,
    `slug: ${slug}`,
    `title: ${title}`,
    "status: draft",
    "version: 1.0",
    `owner: ${owner}`,
    `created: ${date}`,
    `updated: ${date}`,
    planId.length > 0 ? "related_plans:" : "related_plans: []",
  ];
  if (planId.length > 0) lines.push(`  - ${planId}`);
  lines.push(relatedDesigns.length > 0 ? "related_designs:" : "related_designs: []");
  for (const design of relatedDesigns) lines.push(`  - ${design}`);
  lines.push("supersedes: null", "---", "", `# ${id} ${title}`, "");

  for (const section of SPEC_SECTIONS) {
    lines.push(`## ${section.number}. ${section.title}`, "", sectionBody(section.number), "");
  }

  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

// ─── createSpec ──────────────────────────────────────────────────────────────

/**
 * Create a new spec on disk from the canonical template and return its metadata.
 *
 * Never overwrites: the slug is checked up-front and again immediately before
 * writing, the target directory must be free, and the file is written with the
 * `wx` flag (atomic create-only). Concurrent `spec_create` calls for the same
 * slug (or the same NNN) leave exactly one winner; the loser throws an error
 * naming the existing path.
 *
 * Note: `input.sessionId` is accepted for API compatibility but not recorded —
 * the canonical frontmatter has no session key (soft references go through
 * `planId` only).
 */
export function createSpec(projectDir: string, input: SpecCreateInput): SpecCreateResult {
  const slug = validateSpecSlug(input.slug);
  const date = validateSpecDate(input.date ?? todayUtc());
  const specsDir = resolveSpecsDir(projectDir);

  const existing = findSpecDirBySlug(specsDir, slug);
  if (existing !== null) {
    throw new Error(
      `ndomo: spec for slug '${slug}' already exists at ${join(existing, "spec.md")}`,
    );
  }

  const index = nextSpecIndex(specsDir);
  const dirName = buildSpecDirName(index, slug);
  const targetDir = join(specsDir, dirName);
  const filePath = join(targetDir, "spec.md");

  const markdown = buildSpecTemplate({
    index,
    slug,
    title: input.title,
    date,
    planId: input.planId,
    agent: input.agent,
  });

  // Re-check the slug immediately before writing (guards the window between
  // the first check and the actual write in concurrent spec_create calls).
  const racing = findSpecDirBySlug(specsDir, slug);
  if (racing !== null) {
    throw new Error(`ndomo: spec for slug '${slug}' already exists at ${join(racing, "spec.md")}`);
  }

  // Re-check the index too: another create may have taken NNN meanwhile.
  const indexPrefix = `${String(index).padStart(3, "0")}-`;
  let entries: string[] = [];
  try {
    entries = readdirSync(specsDir);
  } catch {
    entries = [];
  }
  const taken = entries.find((e) => e !== dirName && e.startsWith(indexPrefix));
  if (taken !== undefined) {
    throw new Error(
      `ndomo: spec index ${String(index).padStart(3, "0")} is already used by ${join(specsDir, taken)} (concurrent create)`,
    );
  }

  mkdirSync(targetDir, { recursive: true });
  try {
    writeFileSync(filePath, markdown, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      // Same-slug loser of the race: the winner's file is already there —
      // never overwrite it and never delete it.
      throw new Error(`ndomo: spec for slug '${slug}' already exists at ${filePath}`);
    }
    throw new Error(
      `ndomo: could not write spec at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    id: buildSpecId(index),
    slug,
    path: filePath,
    created: true,
    byteSize: Buffer.byteLength(markdown, "utf8"),
  };
}
