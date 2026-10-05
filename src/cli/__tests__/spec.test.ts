/**
 * Tests for src/cli/spec.ts — CLI spec wrapper: list | show | lint.
 *
 * TDD: this file was written FIRST and run against a missing `../spec.ts`
 * (module-not-found) to capture the RED proof, then the module was implemented
 * to turn it green. Tags: AC-009-1, REQ-009.
 *
 * Fixture isolation: every fixture lives in a `mkdtempSync` dir under
 * `os.tmpdir()` (chdir pattern, same as plan.test.ts / task.test.ts). The real
 * repo spec `.ndomo/specs/001-sdd-core/spec.md` is NEVER read by these tests:
 * it is `status: approved` and currently trips L5 on REQ-005/REQ-008, so it
 * could never satisfy an `ok: true` assertion.
 *
 * Coverage:
 * 1.  spec list — two specs, sorted by id, stable row shape, relative path
 * 2.  spec list — empty specs dir → `[]`, exit 0
 * 3.  spec show <id> — spec_get payload shape (no raw / no requirement body)
 * 4.  spec show <path> — same payload by specs-dir relative path
 * 5.  spec show <unknown id> — JSON error naming the id + non-zero exit
 * 6.  spec lint <id> — clean fixture → ok:true, findings:[], exit 0
 * 7.  spec lint <id> — out-of-order required section → L2 error, exit != 0
 * 8.  spec lint <id> — warning-only fixture (L8 empty tests cell) → ok:true, exit 0
 * 9.  spec lint <unknown id> — JSON error naming the id + non-zero exit
 * 10. spec lint --plan <planId> — L6 (task coverage) + L7 (undefined reqId)
 * 11. spec lint --plan without a value → usage error, non-zero exit
 * 12. unknown subcommand → usage error, non-zero exit
 * 13. missing subcommand → usage error, non-zero exit
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../db/migrations.ts";
import { createPlan } from "../../db/plans.ts";
import { createTask } from "../../db/tasks.ts";
import { runSpecCli } from "../spec.ts";

let tmpDir: string;
let origCwd: string;

/** Capture console output and stub process.exit so we can assert on stdout. */
function captureOutput(fn: () => void): {
  stdout: string;
  stderr: string;
  exitCode: number | null;
} {
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(" ")}\n`;
  };
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__process_exit__");
  }) as typeof process.exit;

  try {
    fn();
  } catch (err) {
    if (!(err instanceof Error && err.message === "__process_exit__")) {
      throw err;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }

  return { stdout, stderr, exitCode };
}

/** Run the CLI and return its captured streams plus the returned exit code. */
function run(args: string[]): {
  stdout: string;
  stderr: string;
  code: number | null;
  exitCode: number | null;
} {
  let code: number | null = null;
  const out = captureOutput(() => {
    code = runSpecCli(args);
  });
  return { stdout: out.stdout, stderr: out.stderr, code, exitCode: out.exitCode };
}

// ─── Fixture builders ────────────────────────────────────────────────────────

const SECTION_TITLES: Record<number, string> = {
  1: "Purpose",
  2: "Scope",
  3: "Non-goals",
  4: "Actors",
  5: "Requirements",
  6: "Acceptance Criteria",
  7: "Interfaces / Contracts",
  8: "Data Model",
  9: "Edge Cases",
  10: "NFRs",
  11: "Traceability",
  12: "Open Questions",
  13: "Changelog",
};

const CANONICAL_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** One active REQ with a complete Given/When/Then AC (L5-clean). */
const CLEAN_REQS = [
  "### REQ-001 — Clean requirement",
  "",
  "WHEN the system runs, THE system SHALL behave.",
  "",
  "- AC-001-1: **Given** a state, **When** an action, **Then** an outcome.",
  "- type: ubiq · priority: P1 · owner: unknown · status: active",
].join("\n");

/** Two active REQs (L3-contiguous) for the --plan traceability fixture. */
const TWO_REQS = [
  CLEAN_REQS,
  "",
  "### REQ-002 — Second requirement",
  "",
  "WHEN the other path runs, THE system SHALL also behave.",
  "",
  "- AC-002-1: **Given** another state, **When** another action, **Then** another outcome.",
  "- type: ubiq · priority: P2 · owner: unknown · status: active",
].join("\n");

const MATRIX_HEADER = ["| REQ | AC | Tasks | Tests | state |", "|---|---|---|---|---|"];

/** Matrix row for REQ-001 with a filled tests cell (L8-clean). */
const CLEAN_MATRIX = [
  ...MATRIX_HEADER,
  "| REQ-001 | AC-001-1 | task-1 | src/cli/spec.test.ts | green |",
].join("\n");

/** Matrix rows for both REQs of TWO_REQS (L8-clean). */
const TWO_REQ_MATRIX = [
  ...MATRIX_HEADER,
  "| REQ-001 | AC-001-1 | task-1 | src/cli/spec.test.ts | green |",
  "| REQ-002 | AC-002-1 | task-2 | src/cli/spec.test.ts | green |",
].join("\n");

/** Matrix row with an EMPTY tests cell → L8 warning only. */
const EMPTY_TESTS_MATRIX = [...MATRIX_HEADER, "| REQ-001 | AC-001-1 | task-1 |  | green |"].join(
  "\n",
);

interface SpecFixture {
  /** Specs-dir entry name, e.g. `001-clean`. */
  dirName: string;
  id: string;
  slug: string;
  title?: string;
  status?: string;
  /** Section heading order — default is the canonical 1..13. */
  order?: number[];
  /** Body of `## 5. Requirements`. */
  requirements?: string;
  /** Body of `## 11. Traceability`. */
  matrix?: string;
}

/** Build a complete spec markdown: all 11 frontmatter keys + 13 sections. */
function specMarkdown(f: SpecFixture): string {
  const title = f.title ?? "Fixture Spec";
  const lines = [
    "---",
    `id: ${f.id}`,
    `slug: ${f.slug}`,
    `title: ${title}`,
    `status: ${f.status ?? "draft"}`,
    "version: 1.0",
    "owner: unknown",
    "created: 2026-10-01",
    "updated: 2026-10-01",
    "related_plans: []",
    "related_designs: []",
    "supersedes: null",
    "---",
    "",
    `# ${f.id} ${title}`,
    "",
  ];
  for (const n of f.order ?? CANONICAL_ORDER) {
    let body = `Placeholder body for section ${n}.`;
    if (n === 5) body = f.requirements ?? "";
    if (n === 11) body = f.matrix ?? "";
    lines.push(`## ${n}. ${SECTION_TITLES[n]}`, "", body, "");
  }
  return `${lines.join("\n")}\n`;
}

/** Write `<projectDir>/.ndomo/specs/<dirName>/spec.md` and return its path. */
function writeSpecFixture(projectDir: string, f: SpecFixture): string {
  const dir = join(projectDir, ".ndomo", "specs", f.dirName);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "spec.md");
  writeFileSync(file, specMarkdown(f), "utf8");
  return file;
}

/**
 * Seed a real plan + two tasks whose `metadata.reqIds` feed L6/L7
 * (spec §7 metadata table / TaskMetadata.reqIds).
 */
function seedPlanWithTasks(reqIdsA: string[], reqIdsB: string[]): string {
  const db = new Database(join(tmpDir, ".ndomo", "state.db"));
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  try {
    const plan = createPlan(db, {
      id: crypto.randomUUID(),
      slug: "lint-fixture",
      title: "Lint Fixture",
      status: "draft",
      priority: 2,
      approvedAt: null,
      completedAt: null,
      sessionId: null,
      overview: "fixture plan for --plan lint",
      approach: null,
      complexity: 2,
      createdBy: "test",
      updatedBy: "test",
      sourceSessionId: null,
      sourceMessageId: null,
      category: null,
      owner: "foreman",
      metadata: {},
      archivedAt: null,
    });
    createTask(db, plan.id, {
      description: "task covering the first req",
      agent: "craftsman",
      createdBy: "test",
      metadata: { reqIds: reqIdsA },
    });
    createTask(db, plan.id, {
      description: "task with a dangling reqId",
      agent: "craftsman",
      createdBy: "test",
      metadata: { reqIds: reqIdsB },
    });
    return plan.id;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  origCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "spec-cli-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── spec list ───────────────────────────────────────────────────────────────

describe("spec list", () => {
  test("AC-009-1: ndomo spec list prints specs sorted by id as JSON [REQ-009]", () => {
    // Created in reverse id order so the sort has real work to do.
    writeSpecFixture(tmpDir, { dirName: "002-beta", id: "SPEC-002", slug: "beta", title: "Beta" });
    writeSpecFixture(tmpDir, {
      dirName: "001-alpha",
      id: "SPEC-001",
      slug: "alpha",
      title: "Alpha",
    });

    const { stdout, code } = run(["list"]);
    expect(code).toBe(0);

    const rows = JSON.parse(stdout) as Record<string, string>[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["SPEC-001", "SPEC-002"]);

    const first = rows[0];
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "id",
      "owner",
      "path",
      "slug",
      "status",
      "title",
      "updated",
      "version",
    ]);
    expect(first?.slug).toBe("alpha");
    expect(first?.title).toBe("Alpha");
    expect(first?.status).toBe("draft");
    // path is relative to the project dir, never absolute.
    expect(first?.path).toBe(".ndomo/specs/001-alpha/spec.md");
    expect(first?.path?.startsWith("/")).toBe(false);
  });

  test("AC-009-1: ndomo spec list on an empty specs dir returns [] [REQ-009]", () => {
    mkdirSync(join(tmpDir, ".ndomo"), { recursive: true });

    const { stdout, code } = run(["list"]);
    expect(code).toBe(0);
    const rows = JSON.parse(stdout);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });
});

// ─── spec show ───────────────────────────────────────────────────────────────

describe("spec show", () => {
  test("AC-009-1: ndomo spec show returns the spec_get payload shape [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "001-clean",
      id: "SPEC-001",
      slug: "clean",
      title: "Clean Spec",
      requirements: CLEAN_REQS,
      matrix: CLEAN_MATRIX,
    });

    const { stdout, code } = run(["show", "SPEC-001"]);
    expect(code).toBe(0);

    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "frontmatter",
      "matrix",
      "requirements",
      "sections",
    ]);
    // Never dump the raw document.
    expect(payload.raw).toBeUndefined();

    const frontmatter = payload.frontmatter as Record<string, unknown>;
    expect(frontmatter.id).toBe("SPEC-001");
    expect(frontmatter.status).toBe("draft");

    const sections = payload.sections as { number: number }[];
    expect(sections).toHaveLength(13);
    expect(sections[0]?.number).toBe(1);

    const requirements = payload.requirements as Record<string, unknown>[];
    expect(requirements).toHaveLength(1);
    expect(Object.keys(requirements[0] ?? {}).sort()).toEqual([
      "acs",
      "id",
      "priority",
      "status",
      "type",
    ]);
    expect(requirements[0]?.id).toBe("REQ-001");
    expect(requirements[0]?.type).toBe("ubiq");
    expect(requirements[0]?.priority).toBe("P1");
    expect(requirements[0]?.status).toBe("active");
    // Requirement prose bodies and titles are not part of the contract.
    expect(requirements[0]?.body).toBeUndefined();
    expect(requirements[0]?.title).toBeUndefined();

    const matrix = payload.matrix as { req: string; tests: string }[];
    expect(matrix).toHaveLength(1);
    expect(matrix[0]?.req).toBe("REQ-001");
    expect(matrix[0]?.tests).toBe("src/cli/spec.test.ts");
  });

  test("AC-009-1: ndomo spec show resolves a specs-dir relative path [REQ-009]", () => {
    writeSpecFixture(tmpDir, { dirName: "001-clean", id: "SPEC-001", slug: "clean" });

    const { stdout, code } = run(["show", "001-clean/spec.md"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as { frontmatter: { id: string } };
    expect(payload.frontmatter.id).toBe("SPEC-001");
  });

  test("AC-009-1: ndomo spec show with an unknown id exits non-zero naming it [REQ-009]", () => {
    const { stdout, stderr, code } = run(["show", "SPEC-404"]);
    expect(code).not.toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain("SPEC-404");
    // The error itself is JSON (machine-readable), printed on stderr.
    const parsed = JSON.parse(stderr) as { error: string };
    expect(parsed.error).toContain("SPEC-404");
  });
});

// ─── spec lint ───────────────────────────────────────────────────────────────

describe("spec lint", () => {
  test("AC-009-1: ndomo spec lint on a clean fixture exits 0 with ok:true [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "001-clean",
      id: "SPEC-001",
      slug: "clean",
      requirements: CLEAN_REQS,
      matrix: CLEAN_MATRIX,
    });

    const { stdout, code } = run(["lint", "SPEC-001"]);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as {
      ok: boolean;
      findings: unknown[];
      stats: { reqs: number; acs: number; orphans: number };
    };
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.stats).toEqual({ reqs: 1, acs: 1, orphans: 0 });
  });

  test("AC-009-1: ndomo spec lint exits non-zero on an L2 finding [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "002-scrambled",
      id: "SPEC-002",
      slug: "scrambled",
      requirements: CLEAN_REQS,
      matrix: CLEAN_MATRIX,
      // Sections 2 and 3 swapped → out of canonical order (L2, error).
      order: [1, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    });

    const { stdout, code } = run(["lint", "SPEC-002"]);
    expect(code).not.toBe(0);

    const report = JSON.parse(stdout) as {
      ok: boolean;
      findings: { rule: string; severity: string; message: string }[];
    };
    expect(report.ok).toBe(false);
    const l2 = report.findings.filter((f) => f.rule === "L2");
    expect(l2.length).toBeGreaterThan(0);
    expect(l2.every((f) => f.severity === "error")).toBe(true);
    expect(l2.some((f) => f.message.includes("out of canonical order"))).toBe(true);
  });

  test("AC-009-1: ndomo spec lint with warning-only findings exits 0 (L8) [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "003-warnonly",
      id: "SPEC-003",
      slug: "warnonly",
      requirements: CLEAN_REQS,
      matrix: EMPTY_TESTS_MATRIX,
    });

    const { stdout, code } = run(["lint", "SPEC-003"]);
    expect(code).toBe(0);

    const report = JSON.parse(stdout) as {
      ok: boolean;
      findings: { rule: string; severity: string }[];
    };
    expect(report.ok).toBe(true);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe("L8");
    expect(report.findings[0]?.severity).toBe("warning");
  });

  test("AC-009-1: ndomo spec lint with an unknown id exits non-zero naming it [REQ-009]", () => {
    const { stdout, stderr, code } = run(["lint", "SPEC-404"]);
    expect(code).not.toBe(0);
    expect(stdout.trim()).toBe("");
    expect(stderr).toContain("SPEC-404");
    const parsed = JSON.parse(stderr) as { error: string };
    expect(parsed.error).toContain("SPEC-404");
  });

  test("AC-009-1: ndomo spec lint --plan surfaces L6 and L7 findings [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "004-trace",
      id: "SPEC-004",
      slug: "trace",
      requirements: TWO_REQS,
      matrix: TWO_REQ_MATRIX,
    });
    // Task A covers REQ-001; task B points at a REQ that does not exist.
    const planId = seedPlanWithTasks(["REQ-001"], ["REQ-999"]);

    const { stdout, code } = run(["lint", "SPEC-004", "--plan", planId]);
    expect(code).not.toBe(0);

    const report = JSON.parse(stdout) as {
      ok: boolean;
      findings: { rule: string; severity: string; message: string }[];
      stats: { orphans: number };
    };
    expect(report.ok).toBe(false);

    // L6: REQ-002 is active but no task references it (matrix row exists).
    const l6 = report.findings.find((f) => f.rule === "L6");
    expect(l6?.severity).toBe("error");
    expect(l6?.message).toContain("REQ-002");

    // L7: a task reqId points at an undefined requirement.
    const l7 = report.findings.find((f) => f.rule === "L7");
    expect(l7?.severity).toBe("error");
    expect(l7?.message).toContain("REQ-999");

    expect(report.stats.orphans).toBe(1);
  });

  test("AC-009-1: ndomo spec lint --plan without a value exits non-zero [REQ-009]", () => {
    writeSpecFixture(tmpDir, {
      dirName: "001-clean",
      id: "SPEC-001",
      slug: "clean",
      requirements: CLEAN_REQS,
      matrix: CLEAN_MATRIX,
    });

    const { code, stderr } = run(["lint", "SPEC-001", "--plan"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/--plan/);
  });
});

// ─── usage errors ────────────────────────────────────────────────────────────

describe("spec usage errors", () => {
  test("AC-009-1: ndomo spec rejects an unknown subcommand [REQ-009]", () => {
    const { code, stderr } = run(["bogus"]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/unknown subcommand/);
    expect(stderr).toContain("bogus");
  });

  test("AC-009-1: ndomo spec without a subcommand exits non-zero [REQ-009]", () => {
    const { code, stderr } = run([]);
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/subcommand is required/);
  });
});
