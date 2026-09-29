/**
 * ndomo DB — Design documents (filesystem-backed, no DB migration).
 *
 * Brainstorm / ADR-style design documents serialized to markdown under
 * `<projectDir>/.ndomo/designs/YYYY-MM-DD-{slug}-design.md`.
 *
 * This module is intentionally DB-free: design docs are standalone
 * artifacts (human-readable, diff-friendly, portable). `planId` and
 * `sessionId` are SOFT references recorded in the markdown frontmatter
 * only — there is no FK enforcement because no DB connection is held.
 *
 * Safety guarantees:
 *  - slug is sanitized to ASCII kebab-case (path-traversal-safe).
 *  - date is validated as strict YYYY-MM-DD (no `..` / separators).
 *  - filename collisions are resolved with a numeric suffix (-2, -3, ...).
 *
 * Pattern mirrors src/db/plan-archive.ts (markdown serialize + filesystem write).
 *
 * See task 30c89728 (brainstorm-workflow).
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single design option evaluated during a brainstorm. */
export interface DesignOption {
  name: string;
  description?: string;
  pros?: string[];
  cons?: string[];
}

/** A single D2 diagram attached to a design document. */
export interface DesignDiagram {
  /** Optional heading rendered as `### {title}` above the code fence. */
  title?: string;
  /** D2 source. Blank code is ignored by serialization and validation. */
  code: string;
}

/** Input for {@link createDesign}. Required: slug, title, problem. */
export interface DesignInput {
  slug: string;
  title: string;
  problem: string;
  goals?: string[];
  constraints?: string[];
  /** What is explicitly IN scope (boundaries of the solution space). */
  scope?: string[];
  /** What is explicitly OUT of scope. */
  exclusions?: string[];
  options?: DesignOption[];
  /** When present and non-blank, status becomes "decided"; else "proposed". */
  decision?: string;
  /** Trade-offs accepted by the decision (what we gave up to decide). */
  tradeoffs?: string[];
  consequences?: string[];
  /** D2 diagrams rendered as `## Diagrams` (after Consequences, before Open Questions). */
  diagrams?: DesignDiagram[];
  openQuestions?: string[];
  /** Soft reference — recorded in markdown only, no FK check. */
  planId?: string;
  /** Soft reference — recorded in markdown only, no FK check. */
  sessionId?: string;
  /** Authoring agent. Defaults to "foreman". */
  agent?: string;
  /** Override the date used in the filename (YYYY-MM-DD). Defaults to today. */
  date?: string;
}

export type DesignStatus = "proposed" | "decided";

/** Metadata returned after a design document is written. */
export interface DesignResult {
  slug: string;
  title: string;
  /** Absolute path to the written markdown file. */
  filePath: string;
  /** Filename only (e.g. `2026-08-06-my-design-design.md`). */
  filename: string;
  /** The date segment used in the filename (YYYY-MM-DD). */
  date: string;
  byteSize: number;
  /** Epoch ms when the doc was written. */
  createdAt: number;
  status: DesignStatus;
}

// ─── Validation & sanitization (pure) ────────────────────────────────────────

const SLUG_MAX_LENGTH = 80;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Sanitize a slug to safe ASCII kebab-case for use in a filename.
 * Strips anything outside [a-z0-9-], collapses runs, trims edges.
 * Defeats path traversal: `../etc` → `etc`, `a/../b` → `a-b`.
 */
export function sanitizeDesignSlug(slug: string): string {
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
 *
 * We sanitize first, then check, so callers always get the value that
 * will actually land in the filename.
 */
export function validateDesignSlug(slug: string): string {
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error("ndomo: design slug cannot be empty");
  }
  const clean = sanitizeDesignSlug(slug);
  if (clean.length === 0) {
    throw new Error(
      `ndomo: design slug '${slug}' sanitizes to empty (needs at least one [a-z0-9] char)`,
    );
  }
  return clean;
}

/**
 * Validate a date string as strict YYYY-MM-DD with a real calendar date.
 * Throws on malformed format or impossible dates (e.g. 2026-13-45).
 * Returns the validated string unchanged.
 */
export function validateDesignDate(date: string): string {
  const m = DATE_RE.exec(date);
  if (!m) {
    throw new Error(`ndomo: design date '${date}' must match YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Construct at noon UTC to sidestep DST edge cases, then verify round-trip.
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`ndomo: design date '${date}' is not a valid calendar date`);
  }
  return date;
}

/** Current date as YYYY-MM-DD (UTC), for the default filename date segment. */
function todayUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Build the design filename: `YYYY-MM-DD-{slug}-design.md`.
 * Both inputs MUST be pre-validated (date strict, slug sanitized).
 */
export function buildDesignFilename(date: string, slug: string): string {
  return `${date}-${slug}-design.md`;
}

// ─── Markdown serialization (pure) ───────────────────────────────────────────

/** Derive status from whether a non-blank decision was provided. */
export function deriveDesignStatus(input: DesignInput): DesignStatus {
  return input.decision !== undefined && input.decision.trim().length > 0 ? "decided" : "proposed";
}

function bulletList(items: string[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  return items.filter((i) => i.trim().length > 0).map((i) => `- ${i.trim()}`);
}

function trimNonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Longest contiguous run of backticks in `s`.
 * Sizes the markdown fence so diagram code that contains fences of its own
 * can never close the block early (` ``` ` in code → a 4-backtick fence).
 */
function longestBacktickRun(s: string): number {
  let max = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === "`") {
      run += 1;
      if (run > max) max = run;
    } else {
      run = 0;
    }
  }
  return max;
}

/** Diagrams that carry renderable content: non-null with non-blank `code`. */
function renderableDiagrams(diagrams: DesignDiagram[] | undefined): DesignDiagram[] {
  if (diagrams === undefined || diagrams.length === 0) return [];
  return diagrams.filter(
    (d) => d != null && typeof d.code === "string" && d.code.trim().length > 0,
  );
}

/**
 * Render the body lines of the `## Diagrams` section (heading excluded).
 * Pure. Returns `[]` when nothing is renderable so the caller omits the
 * section entirely (empty list / all-blank codes stay diff-stable).
 */
function renderDiagramLines(diagrams: DesignDiagram[] | undefined): string[] {
  const usable = renderableDiagrams(diagrams);
  if (usable.length === 0) return [];

  const blocks = usable.map((d) => {
    const lines: string[] = [];
    const title = trimNonEmpty(d.title);
    if (title !== undefined) lines.push(`### ${title}`, "");
    const fence = "`".repeat(Math.max(3, longestBacktickRun(d.code) + 1));
    lines.push(`${fence}d2`, d.code, fence);
    return lines;
  });

  // Single blank line between blocks, none after the last one.
  return blocks.flatMap((block, i) => (i === 0 ? block : ["", ...block]));
}

/**
 * Serialize a design document to a stable markdown string.
 * Pure: no I/O. Empty optional sections are omitted entirely so the
 * doc stays readable and diff-stable.
 */
export function serializeDesignToMarkdown(
  input: DesignInput,
  date: string,
  createdAt: number,
): string {
  const status = deriveDesignStatus(input);
  const agent = trimNonEmpty(input.agent) ?? "foreman";
  const planId = trimNonEmpty(input.planId);
  const sessionId = trimNonEmpty(input.sessionId);

  const sections: string[] = [
    `# Design: ${input.title.trim()}`,
    "",
    `**Slug:** ${sanitizeDesignSlug(input.slug)}  `,
    `**Date:** ${date}  `,
    `**Status:** ${status}  `,
    `**Author:** ${agent}  `,
    `**Created:** ${new Date(createdAt).toISOString()}  `,
  ];
  if (planId) sections.push(`**Plan:** ${planId}  `);
  if (sessionId) sections.push(`**Session:** ${sessionId}  `);

  // Problem (required)
  sections.push("", "## Problem", "", input.problem.trim());

  // Goals
  const goals = bulletList(input.goals);
  if (goals.length > 0) sections.push("", "## Goals", "", ...goals);

  // Constraints
  const constraints = bulletList(input.constraints);
  if (constraints.length > 0) sections.push("", "## Constraints", "", ...constraints);

  // Scope (framing — what's IN)
  const scope = bulletList(input.scope);
  if (scope.length > 0) sections.push("", "## Scope", "", ...scope);

  // Exclusions (framing — what's OUT)
  const exclusions = bulletList(input.exclusions);
  if (exclusions.length > 0) sections.push("", "## Exclusions", "", ...exclusions);

  // Options Considered
  const opts = input.options ?? [];
  const validOpts = opts.filter((o) => o && trimNonEmpty(o.name));
  if (validOpts.length > 0) {
    sections.push("", "## Options Considered", "");
    for (const opt of validOpts) {
      sections.push(`### ${opt.name.trim()}`, "");
      const desc = trimNonEmpty(opt.description);
      if (desc) sections.push(desc, "");
      const pros = bulletList(opt.pros);
      if (pros.length > 0) sections.push("**Pros:**", "", ...pros, "");
      const cons = bulletList(opt.cons);
      if (cons.length > 0) sections.push("**Cons:**", "", ...cons, "");
    }
  }

  // Decision
  const decision = trimNonEmpty(input.decision);
  if (decision) sections.push("", "## Decision", "", decision);

  // Trade-offs (accepted by the decision — what we gave up)
  const tradeoffs = bulletList(input.tradeoffs);
  if (tradeoffs.length > 0) sections.push("", "## Trade-offs", "", ...tradeoffs);

  // Consequences
  const consequences = bulletList(input.consequences);
  if (consequences.length > 0) sections.push("", "## Consequences", "", ...consequences);

  // Diagrams (D2) — between Consequences and Open Questions
  const diagramLines = renderDiagramLines(input.diagrams);
  if (diagramLines.length > 0) sections.push("", "## Diagrams", "", ...diagramLines);

  // Open Questions
  const openQ = bulletList(input.openQuestions);
  if (openQ.length > 0) sections.push("", "## Open Questions", "", ...openQ);

  return `${sections.join("\n")}\n`;
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

/**
 * Resolve the per-project design docs directory.
 * Path: `<projectDir>/.ndomo/designs/`. Creates it if missing.
 */
export function resolveDesignDir(projectDir: string): string {
  const dir = join(projectDir, ".ndomo", "designs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Find a collision-free filename inside `dir` for the proposed base name.
 * If `base.md` exists, tries `base-2.md`, `base-3.md`, ... up to a sane cap.
 */
function resolveCollision(dir: string, filename: string): string {
  const candidate = join(dir, filename);
  if (!existsSync(candidate)) return filename;
  const stem = filename.replace(/\.md$/, "");
  for (let n = 2; n <= 999; n++) {
    const next = `${stem}-${n}.md`;
    if (!existsSync(join(dir, next))) return next;
  }
  throw new Error(`ndomo: too many design-doc collisions for '${filename}' in ${dir}`);
}

/**
 * Best-effort validation of D2 diagrams via the `d2` CLI.
 *
 * Semantics (chosen so authoring never breaks silently but never blocks
 * on a missing tool either):
 *  - nothing to check (absent / empty / all-blank codes) → no-op;
 *  - `d2` missing (ENOENT) → silent skip, no throw (CI images may lack d2);
 *  - `d2 validate` exit ≠ 0 → throw with the diagram index/title + d2 output,
 *    so `createDesign` refuses to write the document (invalid diagram wins
 *    over "write something");
 *  - temp files always cleaned in `finally` (best-effort).
 *
 * The binary/timeout are injectable for tests (d2 may not exist there).
 */
export interface DiagramValidationOptions {
  /** d2 binary. Defaults to `d2` (resolved through `$PATH`). */
  bin?: string;
  /** Per-diagram timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
}

const D2_BIN = "d2";
const D2_VALIDATE_TIMEOUT_MS = 10_000;

/** Human label for error messages: `#2 ('Flow')` or `#2`. */
function diagramLabel(d: DesignDiagram, index: number): string {
  const title = trimNonEmpty(d.title);
  const label = `#${index + 1}`;
  return title === undefined ? label : `${label} ('${title}')`;
}

export function validateDiagrams(
  diagrams: DesignDiagram[] | undefined,
  options: DiagramValidationOptions = {},
): void {
  const usable = renderableDiagrams(diagrams);
  if (usable.length === 0) return;

  const bin = options.bin ?? D2_BIN;
  const timeoutMs = options.timeoutMs ?? D2_VALIDATE_TIMEOUT_MS;
  let dir: string | undefined;

  try {
    dir = mkdtempSync(join(tmpdir(), "ndomo-d2-"));
    for (const [i, d] of usable.entries()) {
      const label = diagramLabel(d, i);
      const tmpFile = join(dir, `diagram-${i + 1}.d2`);
      writeFileSync(tmpFile, d.code, "utf-8");

      const res = spawnSync(bin, ["validate", tmpFile], {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: "pipe",
      });

      if (res.error !== null && res.error !== undefined) {
        const errno = res.error as { code?: string };
        // d2 not installed → best-effort skip (silent, no throw).
        if (errno.code === "ENOENT") return;
        throw new Error(
          `ndomo: could not run '${bin} validate' for diagram ${label}: ${res.error.message}`,
        );
      }

      if (res.status !== 0) {
        const detail = (res.stderr ?? res.stdout ?? "").trim();
        const reason =
          res.signal != null
            ? `killed by ${res.signal} (timeout ${timeoutMs}ms)`
            : `exit code ${String(res.status)}`;
        throw new Error(
          `ndomo: d2 diagram ${label} failed validation (${reason})${detail.length > 0 ? `: ${detail}` : ""}`,
        );
      }
    }
  } finally {
    if (dir !== undefined) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Create (write) a design document to the filesystem and return its metadata.
 *
 * Validation is defensive: slug is sanitized + validated, date is validated
 * (or defaulted to today UTC). The directory is created on demand. Filename
 * collisions are resolved with a numeric suffix — never overwrites.
 *
 * @param projectDir Absolute path to the project root.
 * @param input Design input (slug + title + problem required).
 * @returns Metadata about the written file.
 */
export function createDesign(projectDir: string, input: DesignInput): DesignResult {
  const slug = validateDesignSlug(input.slug);
  const date = validateDesignDate(input.date ?? todayUtc());

  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new Error("ndomo: design title cannot be empty");
  }
  if (typeof input.problem !== "string" || input.problem.trim().length === 0) {
    throw new Error("ndomo: design problem cannot be empty");
  }

  // Reject invalid D2 BEFORE any write: a failed validation must leave no md.
  validateDiagrams(input.diagrams);

  const dir = resolveDesignDir(projectDir);
  const createdAt = Date.now();
  const md = serializeDesignToMarkdown(input, date, createdAt);

  const filename = resolveCollision(dir, buildDesignFilename(date, slug));
  const filePath = join(dir, filename);
  writeFileSync(filePath, md, "utf-8");

  return {
    slug,
    title: input.title.trim(),
    filePath,
    filename,
    date,
    byteSize: Buffer.byteLength(md, "utf-8"),
    createdAt,
    status: deriveDesignStatus(input),
  };
}
