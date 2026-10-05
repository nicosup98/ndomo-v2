/**
 * ndomo spec — deterministic linter (rules L0–L9, SPEC-001 §7).
 *
 * Design constraints (NFRs from the spec):
 *  - Deterministic: same document + same context ⇒ byte-identical JSON report.
 *    No timestamps, no random ids, no `Date.now()` inside messages; the clock
 *    is injected through `ctx.now` (defaults to `new Date()`).
 *  - Total: `lintSpecFile` never throws; a missing/unreadable file is an L0
 *    error finding naming the path.
 *  - Findings are sorted by `line` asc, then `rule` asc, then `message` asc
 *    (plain code-unit comparison — locale-independent).
 *  - `ok` is false iff at least one error-severity finding exists; warnings
 *    (L8, L9) never flip it.
 *  - Messages are English (code), even though spec prose may be Spanish.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { FrontmatterScan, SpecDocument, SpecRequirement } from "./parse.ts";
import { parseSpec, scanFences, scanFrontmatter } from "./parse.ts";
import { isValidSpecDate, isValidSpecId, resolveSpecPath, SPEC_SECTIONS } from "./template.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

/** One lint violation. `line` is 1-based (1 = document start / frontmatter). */
export interface SpecFinding {
  rule: string;
  severity: "error" | "warning";
  line: number;
  message: string;
}

/** Lint report. Two runs over the same input produce byte-identical JSON. */
export interface LintReport {
  ok: boolean;
  findings: SpecFinding[];
  stats: { reqs: number; acs: number; orphans: number };
}

/** Context injected into a lint run (traceability tasks + the clock). */
export interface LintContext {
  /** Plan tasks carrying `metadata.reqIds`, for L6/L7 traceability checks. */
  tasks?: { id: string; reqIds: string[] }[] | undefined;
  /** Injected clock for L9 staleness. Defaults to `new Date()`. */
  now?: Date | undefined;
}

// ─── Rule tables ─────────────────────────────────────────────────────────────

const REQUIRED_FRONTMATTER_KEYS = [
  "id",
  "slug",
  "title",
  "status",
  "version",
  "owner",
  "created",
  "updated",
  "related_plans",
  "related_designs",
  "supersedes",
] as const;

/** Statuses at or beyond `approved`: clarification markers become L4 errors. */
const L4_BLOCKING_STATUSES = new Set(["approved", "implementing", "verified", "deprecated"]);

/** Statuses subject to the L9 staleness warning. */
const L9_STALE_STATUSES = new Set(["implementing", "verified"]);

const CLARIFICATION_RE = /\[NEEDS CLARIFICATION(\s*:[^\]]*)?\]/;
const REQ_ID_RE = /^REQ-\d{3}$/;
const L9_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Sorting ─────────────────────────────────────────────────────────────────

/** Locale-independent string order (code units) for determinism. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortFindings(findings: SpecFinding[]): SpecFinding[] {
  return findings.sort(
    (a, b) =>
      a.line - b.line || compareStrings(a.rule, b.rule) || compareStrings(a.message, b.message),
  );
}

// ─── L1: frontmatter ─────────────────────────────────────────────────────────

function checkFrontmatter(fm: FrontmatterScan, findings: SpecFinding[]): void {
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    if (!(key in fm.values)) {
      findings.push({
        rule: "L1",
        severity: "error",
        line: 1,
        message: `missing required frontmatter key '${key}'`,
      });
    }
  }

  const id = fm.values.id;
  if ("id" in fm.values && (typeof id !== "string" || !isValidSpecId(id))) {
    findings.push({
      rule: "L1",
      severity: "error",
      line: fm.keyLines.get("id") ?? 1,
      message: `frontmatter key 'id' must match SPEC-\\d{3} (got '${typeof id === "string" ? id : ""}')`,
    });
  }

  for (const key of ["created", "updated"] as const) {
    if (!(key in fm.values)) continue;
    const value = fm.values[key];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      findings.push({
        rule: "L1",
        severity: "error",
        line: fm.keyLines.get(key) ?? 1,
        message: `frontmatter key '${key}' must be an ISO date YYYY-MM-DD (got '${typeof value === "string" ? value : ""}')`,
      });
    } else if (!isValidSpecDate(value)) {
      findings.push({
        rule: "L1",
        severity: "error",
        line: fm.keyLines.get(key) ?? 1,
        message: `frontmatter key '${key}' is not a valid calendar date (got '${value}')`,
      });
    }
  }

  for (const bad of fm.malformed) {
    findings.push({
      rule: "L1",
      severity: "error",
      line: bad.line,
      message: `malformed frontmatter line: '${bad.text}'`,
    });
  }
}

// ─── L2: sections ────────────────────────────────────────────────────────────

const MAX_SECTION_NUMBER = 13;

function checkSections(sections: SpecDocument["sections"], findings: SpecFinding[]): void {
  const presentNumbers = new Set(sections.map((s) => s.number));
  const absentNumbers = new Set(
    SPEC_SECTIONS.filter((d) => !presentNumbers.has(d.number)).map((d) => d.number),
  );

  const seen = new Set<number>();
  let extrasBefore = 0; // duplicated or out-of-range sections seen so far

  for (const [position, section] of sections.entries()) {
    if (section.number < 1 || section.number > MAX_SECTION_NUMBER) {
      findings.push({
        rule: "L2",
        severity: "error",
        line: section.line,
        message: `section '${section.number}. ${section.title}' is outside the canonical range 1-${MAX_SECTION_NUMBER}`,
      });
      extrasBefore++;
      continue;
    }
    if (seen.has(section.number)) {
      findings.push({
        rule: "L2",
        severity: "error",
        line: section.line,
        message: `duplicated section number ${section.number} ('${section.number}. ${section.title}')`,
      });
      extrasBefore++;
      continue;
    }
    seen.add(section.number);

    let missingBefore = 0;
    for (const absent of absentNumbers) {
      if (absent < section.number) missingBefore++;
    }
    const expected = section.number - 1 - missingBefore + extrasBefore;
    if (expected !== position) {
      findings.push({
        rule: "L2",
        severity: "error",
        line: section.line,
        message: `section '${section.number}. ${section.title}' is out of canonical order (found at position ${position + 1}, expected position ${expected + 1})`,
      });
    }
  }

  for (const descriptor of SPEC_SECTIONS) {
    if (!descriptor.required || presentNumbers.has(descriptor.number)) continue;
    // Anchor the finding on the first heading that sits where the missing
    // section should have been (the first heading out of its canonical slot).
    const after = sections.find((s) => s.number > descriptor.number);
    const before = [...sections].reverse().find((s) => s.number < descriptor.number);
    const line = after?.line ?? before?.line ?? 1;
    findings.push({
      rule: "L2",
      severity: "error",
      line,
      message: `required section '${descriptor.number}. ${descriptor.title}' is missing`,
    });
  }
}

// ─── L3: requirement ids ─────────────────────────────────────────────────────

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function checkRequirementIds(requirements: SpecRequirement[], findings: SpecFinding[]): void {
  const accepted: { id: string; line: number }[] = [];
  for (const req of requirements) {
    if (!REQ_ID_RE.test(req.id)) {
      findings.push({
        rule: "L3",
        severity: "error",
        line: req.line,
        message: `malformed requirement id '${req.id}' (expected REQ-NNN)`,
      });
      continue;
    }
    const first = accepted.find((a) => a.id === req.id);
    if (first !== undefined) {
      findings.push({
        rule: "L3",
        severity: "error",
        line: req.line,
        message: `duplicate requirement id '${req.id}' (first defined at line ${first.line})`,
      });
      continue;
    }
    accepted.push({ id: req.id, line: req.line });
  }

  const sorted = [...accepted].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
  let previous = 0;
  for (const entry of sorted) {
    const n = Number(entry.id.slice(4));
    if (n > previous + 1) {
      const missing: string[] = [];
      for (let m = previous + 1; m < n; m++) missing.push(`REQ-${pad3(m)}`);
      const list =
        missing.length <= 4
          ? missing.join(", ")
          : `${String(missing.length)} ids (${missing[0] ?? ""} ... ${missing[missing.length - 1] ?? ""})`;
      findings.push({
        rule: "L3",
        severity: "error",
        line: entry.line,
        message: `requirement numbering gap: missing ${list} before ${entry.id}`,
      });
    }
    if (n > previous) previous = n;
  }
}

// ─── L4: clarification markers ───────────────────────────────────────────────

function checkClarifications(
  doc: SpecDocument,
  fm: FrontmatterScan,
  status: string,
  findings: SpecFinding[],
): void {
  if (!L4_BLOCKING_STATUSES.has(status)) return;
  const lines = doc.raw.split("\n");
  const fence = scanFences(lines);

  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;
    if (fm.startLine > 0 && lineNo >= fm.startLine && lineNo <= fm.endLine) continue;
    if (fence[i]) continue;
    // Markers quoted as inline code are syntax references (the rules table, a
    // "no markers remain" note), not open clarifications — they never fire.
    const prose = line.replace(/`[^`]*`/g, "");
    if (CLARIFICATION_RE.test(prose)) {
      findings.push({
        rule: "L4",
        severity: "error",
        line: lineNo,
        message: `[NEEDS CLARIFICATION] marker on line ${lineNo} is not allowed while status is '${status}'`,
      });
    }
  }
}

// ─── L5/L6/L7/L8: traceability ──────────────────────────────────────────────

function l6Message(id: string, hasTask: boolean, hasMatrix: boolean): string {
  if (!hasTask && !hasMatrix) {
    return `active requirement ${id} has no task referencing it and no traceability matrix row`;
  }
  if (!hasTask) return `active requirement ${id} has no task referencing it`;
  return `active requirement ${id} has no traceability matrix row`;
}

function checkTraceability(doc: SpecDocument, ctx: LintContext, findings: SpecFinding[]): number {
  const matrixReqs = new Set(doc.matrix.map((row) => row.req));
  let orphans = 0;

  for (const req of doc.requirements) {
    if (req.status !== "active") continue; // L5 and L6 apply to active REQs only

    const hasCompleteAc = req.acs.some(
      (ac) => ac.given !== undefined && ac.when !== undefined && ac.then !== undefined,
    );
    if (!hasCompleteAc) {
      findings.push({
        rule: "L5",
        severity: "error",
        line: req.line,
        message: `active requirement ${req.id} has no acceptance criterion with Given/When/Then`,
      });
    }

    const hasMatrix = matrixReqs.has(req.id);
    const hasTask = ctx.tasks === undefined || ctx.tasks.some((t) => t.reqIds.includes(req.id));
    if (!hasMatrix || !hasTask) {
      findings.push({
        rule: "L6",
        severity: "error",
        line: req.line,
        message: l6Message(req.id, hasTask, hasMatrix),
      });
      orphans++;
    }
  }

  const byId = new Map(doc.requirements.map((r) => [r.id, r]));
  for (const task of ctx.tasks ?? []) {
    for (const reqId of task.reqIds) {
      const target = byId.get(reqId);
      if (target === undefined) {
        findings.push({
          rule: "L7",
          severity: "error",
          line: 1,
          message: `task '${task.id}' references undefined requirement '${reqId}'`,
        });
      } else if (target.status !== "active") {
        findings.push({
          rule: "L7",
          severity: "error",
          line: 1,
          message: `task '${task.id}' references requirement '${reqId}' with status '${target.status}'`,
        });
      }
    }
  }

  for (const row of doc.matrix) {
    if (row.tests.trim().length === 0) {
      findings.push({
        rule: "L8",
        severity: "warning",
        line: row.line,
        message: `traceability row for '${row.req}' has an empty tests cell`,
      });
    }
  }

  return orphans;
}

// ─── L9: staleness ───────────────────────────────────────────────────────────

function checkStaleness(
  fm: FrontmatterScan,
  status: string,
  ctx: LintContext,
  findings: SpecFinding[],
): void {
  if (!L9_STALE_STATUSES.has(status)) return;
  const updated = fm.values.updated;
  if (typeof updated !== "string" || !isValidSpecDate(updated)) return;
  const now = ctx.now ?? new Date();
  const updatedMs = Date.parse(`${updated}T00:00:00Z`);
  if (!Number.isFinite(updatedMs)) return;
  if (now.getTime() - updatedMs > L9_MAX_AGE_MS) {
    findings.push({
      rule: "L9",
      severity: "warning",
      line: fm.keyLines.get("updated") ?? 1,
      message: `frontmatter 'updated' (${updated}) is more than 30 days old while status is '${status}'`,
    });
  }
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Lint a parsed spec document. Pure: no I/O, no AI, no network. The clock is
 * injectable (`ctx.now`) so L9 is testable and runs are reproducible.
 */
export function lintSpec(doc: SpecDocument, ctx: LintContext = {}): LintReport {
  const findings: SpecFinding[] = [];
  const fm = scanFrontmatter(doc.raw);
  const status = typeof fm.values.status === "string" ? fm.values.status : "";

  checkFrontmatter(fm, findings);
  checkSections(doc.sections, findings);
  checkRequirementIds(doc.requirements, findings);
  checkClarifications(doc, fm, status, findings);
  const orphans = checkTraceability(doc, ctx, findings);
  checkStaleness(fm, status, ctx, findings);

  sortFindings(findings);

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    stats: {
      reqs: doc.requirements.length,
      acs: doc.requirements.reduce((sum, r) => sum + r.acs.length, 0),
      orphans,
    },
  };
}

/** Human-readable label for an unresolved spec reference (used in L0). */
function missingLabel(projectDir: string, idOrPath: string): string {
  const input = idOrPath.trim();
  if (input.length === 0) return resolve(projectDir);
  if (isAbsolute(input)) return input;
  if (/^SPEC-\d{3}$/.test(input)) {
    return `${input} (no spec with this id under ${join(resolve(projectDir), ".ndomo", "specs")})`;
  }
  if (/^\d+-/.test(input)) {
    const specsDir = join(resolve(projectDir), ".ndomo", "specs");
    return input.endsWith("spec.md") ? join(specsDir, input) : join(specsDir, input, "spec.md");
  }
  return resolve(projectDir, input);
}

/**
 * Lint a spec file from disk. NEVER throws: a missing or unreadable file
 * yields an L0 error finding naming the path (SPEC-001 §9 edge case: T0 must
 * block approval with the missing path, not a generic crash).
 */
export function lintSpecFile(
  projectDir: string,
  idOrPath: string,
  ctx: LintContext = {},
): LintReport {
  const l0 = (path: string): LintReport => ({
    ok: false,
    findings: [
      {
        rule: "L0",
        severity: "error",
        line: 1,
        message: `spec file not found or unreadable: ${path}`,
      },
    ],
    stats: { reqs: 0, acs: 0, orphans: 0 },
  });

  const resolved = resolveSpecPath(projectDir, idOrPath);
  if (resolved === null) return l0(missingLabel(projectDir, idOrPath));

  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    return l0(resolved);
  }
  return lintSpec(parseSpec(raw, { sourcePath: resolved }), ctx);
}
