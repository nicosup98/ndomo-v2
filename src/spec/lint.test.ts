/**
 * Tests for the deterministic spec linter (rules L0–L9, SPEC-001 §7).
 *
 * Every test carries its REQ/AC tag. Context (tasks, "now") is injected so the
 * linter stays deterministic; fixtures are inline strings or temp dirs only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LintReport, SpecFinding } from "./index.ts";
import { createSpec, lintSpec, lintSpecFile, parseSpec } from "./index.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "spec-lint-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CANONICAL_TITLES: Record<number, string> = {
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

function reqBlock(n: number, opts: { status?: string; gwt?: boolean | "partial" } = {}): string {
  const id = `REQ-${String(n).padStart(3, "0")}`;
  const acNum = String(n).padStart(3, "0");
  const status = opts.status ?? "active";
  let ac: string;
  if (opts.gwt === false) {
    ac = `- AC-${acNum}-1: covers the happy path.`;
  } else if (opts.gwt === "partial") {
    ac = `- AC-${acNum}-1: **Given** a precondition, **Then** an outcome.`;
  } else {
    ac = `- AC-${acNum}-1: **Given** a precondition, **When** an action, **Then** an outcome.`;
  }
  return [
    `### ${id} — Requirement ${n}`,
    "",
    `WHEN something happens, THE system SHALL react for requirement ${n}.`,
    "",
    ac,
    `- type: ubiq · priority: P1 · owner: tester · status: ${status}`,
  ].join("\n");
}

interface SpecMdOptions {
  status?: string;
  extraFrontmatter?: string[];
  omitFrontmatterKeys?: string[];
  idValue?: string;
  createdValue?: string;
  updatedValue?: string;
  omitSections?: number[];
  section5?: string;
  section11?: string;
  section12?: string;
}

/** Canonical lint-clean spec document; individual rules are introduced per test. */
function specMd(opts: SpecMdOptions = {}): string {
  const omit = new Set(opts.omitSections ?? []);
  const skip = new Set(opts.omitFrontmatterKeys ?? []);
  const fm: string[] = [];
  const push = (key: string, value: string): void => {
    if (!skip.has(key)) fm.push(`${key}: ${value}`);
  };
  push("id", opts.idValue ?? "SPEC-007");
  push("slug", "fixture");
  push("title", "Fixture Spec");
  push("status", opts.status ?? "draft");
  push("version", "1.0");
  push("owner", "tester");
  push("created", opts.createdValue ?? "2026-10-01");
  push("updated", opts.updatedValue ?? "2026-10-01");
  if (!skip.has("related_plans")) fm.push("related_plans:", "  - plan-aaa");
  if (!skip.has("related_designs")) fm.push("related_designs: []");
  if (!skip.has("supersedes")) fm.push("supersedes: null");

  const parts: string[] = [
    "---",
    ...fm,
    ...(opts.extraFrontmatter ?? []),
    "---",
    "",
    "# SPEC-007 Fixture Spec",
    "",
  ];
  const bodies: Record<number, string> = {
    1: "Why this fixture exists.",
    2: "What is in scope.",
    3: "What is out of scope.",
    4: "Who interacts with the feature.",
    5: opts.section5 ?? reqBlock(1),
    6: "ACs live nested under each requirement.",
    7: "Tools and contracts.",
    8: "No schema changes.",
    9: "Edge cases table.",
    10: "Determinism required.",
    11:
      opts.section11 ??
      [
        "| REQ | AC | Tasks | Tests | state |",
        "|---|---|---|---|---|",
        "| REQ-001 | AC-001-1 | task-1 | src/thing.test.ts | red |",
      ].join("\n"),
    12: opts.section12 ?? "_(none)_",
    13: "- **2026-10-01 v1.0 (tester)** — initial.",
  };
  for (let n = 1; n <= 13; n++) {
    if (omit.has(n)) continue;
    const body = (bodies[n] ?? "").replace(/\s+$/, "");
    parts.push(`## ${n}. ${CANONICAL_TITLES[n]}`, "", body, "");
  }
  return `${parts.join("\n").replace(/\s+$/, "")}\n`;
}

function lintOf(md: string, ctx?: Parameters<typeof lintSpec>[1]): LintReport {
  return lintSpec(parseSpec(md), ctx);
}

function ofRule(report: LintReport, rule: string): SpecFinding[] {
  return report.findings.filter((f) => f.rule === rule);
}

function lineOf(md: string, needle: string): number {
  return md.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

// ─── L0 ─────────────────────────────────────────────────────────────────────

describe("L0", () => {
  test("[REQ-002] L0: missing file yields L0 naming the missing path and never throws", () => {
    const report = lintSpecFile(projectDir, "001-missing/spec.md");
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    const finding = report.findings[0];
    expect(finding?.rule).toBe("L0");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain(join(".ndomo", "specs", "001-missing", "spec.md"));
    expect(report.stats).toEqual({ reqs: 0, acs: 0, orphans: 0 });
  });

  test("[REQ-002] L0: unknown SPEC-id also reports L0 without throwing", () => {
    const report = lintSpecFile(projectDir, "SPEC-999");
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.rule).toBe("L0");
    expect(report.findings[0]?.message).toContain("SPEC-999");
  });

  test("[REQ-002] L0: unreadable file (not markdown) reports L0 instead of crashing", () => {
    const specsDir = join(projectDir, ".ndomo", "specs");
    mkdirSync(join(specsDir, "002-weird"), { recursive: true });
    // A directory in place of spec.md → read fails → L0.
    mkdirSync(join(specsDir, "002-weird", "spec.md"), { recursive: true });
    const report = lintSpecFile(projectDir, "002-weird/spec.md");
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.rule).toBe("L0");
  });
});

// ─── L1 ─────────────────────────────────────────────────────────────────────

describe("L1", () => {
  test("[REQ-002] L1: missing required frontmatter key fires L1", () => {
    const report = lintOf(specMd({ omitFrontmatterKeys: ["owner"] }));
    const findings = ofRule(report, "L1");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("'owner'");
    expect(report.ok).toBe(false);
  });

  test("[REQ-002] L1: id not matching SPEC-\\d{3} fires L1", () => {
    const report = lintOf(specMd({ idValue: "SPEC-X" }));
    const findings = ofRule(report, "L1");
    expect(findings.some((f) => f.message.includes("'id'") && f.message.includes("SPEC-X"))).toBe(
      true,
    );
  });

  test("[REQ-002] L1: non-ISO or impossible dates fire L1", () => {
    const badFormat = ofRule(lintOf(specMd({ createdValue: "yesterday" })), "L1");
    expect(badFormat.some((f) => f.message.includes("'created'"))).toBe(true);
    const badCalendar = ofRule(lintOf(specMd({ updatedValue: "2026-13-45" })), "L1");
    expect(badCalendar.some((f) => f.message.includes("'updated'"))).toBe(true);
  });

  test("[REQ-002] L1: a document without frontmatter fires one finding per required key", () => {
    const report = lintOf("# Just a heading\n\nNo frontmatter here.\n");
    const findings = ofRule(report, "L1");
    expect(findings).toHaveLength(11);
    expect(report.ok).toBe(false);
  });
});

// ─── L2 ─────────────────────────────────────────────────────────────────────

describe("L2", () => {
  test("AC-002-1: missing section 5 returns L2 at the line of the first out-of-order heading [REQ-002]", () => {
    const md = specMd({ omitSections: [5] });
    const report = lintOf(md);
    const findings = ofRule(report, "L2");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.line).toBe(lineOf(md, "## 6. Acceptance Criteria"));
    expect(findings[0]?.message).toContain("Requirements");
    expect(report.ok).toBe(false);
  });

  test("[REQ-002] L2: duplicated section number fires L2 at the second heading", () => {
    const md = `${specMd()}\n## 2. Scope (again)\n\nDuplicated section.\n`;
    const report = lintOf(md);
    const findings = ofRule(report, "L2");
    expect(findings.some((f) => f.line === lineOf(md, "## 2. Scope (again)"))).toBe(true);
    expect(findings[0]?.message).toContain("duplicated");
  });

  test("[REQ-002] L2: out-of-order sections fire L2 at each displaced heading", () => {
    const defaultMd = specMd();
    const lines = defaultMd.split("\n");
    const idx3 = lines.findIndex((l) => l.startsWith("## 3."));
    const idx4 = lines.findIndex((l) => l.startsWith("## 4."));
    expect(idx3).toBeGreaterThan(-1);
    expect(idx4).toBeGreaterThan(idx3);
    // Swap the "## 3. Non-goals" and "## 4. Actors" headings (bodies follow in place).
    lines[idx3] = "## 4. Actors";
    lines[idx4] = "## 3. Non-goals";
    const md = lines.join("\n");
    const findings = ofRule(lintOf(md), "L2");
    expect(findings).toHaveLength(2);
    expect(findings.some((f) => f.line === idx3 + 1)).toBe(true);
    expect(findings.some((f) => f.line === idx4 + 1)).toBe(true);
    expect(findings[0]?.message).toContain("canonical order");
  });

  test("[REQ-002] L2: optional sections 7-10 and 12 may be absent without findings", () => {
    const report = lintOf(specMd({ omitSections: [7, 8, 9, 10, 12] }));
    expect(ofRule(report, "L2")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─── L3 ─────────────────────────────────────────────────────────────────────

describe("L3", () => {
  test("[REQ-002] L3: malformed REQ id fires L3", () => {
    const section5 = ["### REQ-X2 — Bad id", "", "WHEN x, THE system SHALL y.", ""].join("\n");
    const report = lintOf(specMd({ section5 }));
    const findings = ofRule(report, "L3");
    expect(findings.some((f) => f.message.includes("REQ-X2"))).toBe(true);
    expect(findings[0]?.severity).toBe("error");
  });

  test("[REQ-002] L3: duplicate REQ id fires L3 naming both lines", () => {
    const section5 = [reqBlock(1), reqBlock(1)].join("\n");
    const report = lintOf(specMd({ section5 }));
    const findings = ofRule(report, "L3");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("duplicate");
    expect(findings[0]?.message).toContain("REQ-001");
  });

  test("[REQ-002] L3: numbering gap fires L3 naming the missing id", () => {
    const section5 = [reqBlock(1), reqBlock(3)].join("\n");
    const report = lintOf(specMd({ section5 }));
    const findings = ofRule(report, "L3");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("REQ-002");
    expect(report.ok).toBe(false);
  });
});

// ─── L4 ─────────────────────────────────────────────────────────────────────

describe("L4", () => {
  const markerSection12 = "Open item: [NEEDS CLARIFICATION: which transport?].";

  test("AC-007-1: status approved with 1 marker returns L4 naming the line [REQ-007]", () => {
    const md = specMd({ status: "approved", section12: markerSection12 });
    const report = lintOf(md);
    const findings = ofRule(report, "L4");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.line).toBe(lineOf(md, "[NEEDS CLARIFICATION"));
    expect(report.ok).toBe(false);
  });

  test("AC-007-2: the same file with status in-review returns no L4 [REQ-007]", () => {
    const report = lintOf(specMd({ status: "in-review", section12: markerSection12 }));
    expect(ofRule(report, "L4")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  test("[REQ-007] L4: fires for implementing, verified and deprecated; tolerated in draft", () => {
    for (const status of ["implementing", "verified", "deprecated"]) {
      const report = lintOf(specMd({ status, section12: markerSection12 }));
      expect(ofRule(report, "L4")).toHaveLength(1);
    }
    const draft = lintOf(specMd({ status: "draft", section12: markerSection12 }));
    expect(ofRule(draft, "L4")).toHaveLength(0);
  });

  test("[REQ-007] L4: bare marker without colon also fires", () => {
    const report = lintOf(
      specMd({ status: "approved", section12: "Still open: [NEEDS CLARIFICATION]" }),
    );
    expect(ofRule(report, "L4")).toHaveLength(1);
  });

  test("[REQ-007] L4: marker quoted as code is a syntax reference, not an open marker", () => {
    const report = lintOf(
      specMd({
        status: "approved",
        section12: "_(empty — no `[NEEDS CLARIFICATION]` markers remain)_",
      }),
    );
    expect(ofRule(report, "L4")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─── L5 ─────────────────────────────────────────────────────────────────────

describe("L5", () => {
  test("[REQ-002] L5: active requirement whose AC lacks Given/When/Then fires L5", () => {
    const md = specMd({ section5: reqBlock(1, { gwt: false }) });
    const report = lintOf(md);
    const findings = ofRule(report, "L5");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(lineOf(md, "### REQ-001"));
    expect(findings[0]?.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  test("[REQ-002] L5: active requirement with a complete Given/When/Then AC passes", () => {
    const report = lintOf(specMd({ section5: reqBlock(1) }));
    expect(ofRule(report, "L5")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  test("[REQ-002] L5: skips non-active requirements (deferred/dropped/deprecated)", () => {
    for (const status of ["deferred", "dropped", "deprecated"]) {
      const report = lintOf(specMd({ section5: reqBlock(1, { gwt: false, status }) }));
      expect(ofRule(report, "L5")).toHaveLength(0);
      expect(report.ok).toBe(true);
    }
  });

  test("[REQ-002] L5: an AC with only Given/Then (missing When) does not satisfy L5", () => {
    const report = lintOf(specMd({ section5: reqBlock(1, { gwt: "partial" }) }));
    expect(ofRule(report, "L5")).toHaveLength(1);
  });

  test("[REQ-002] L5: a requirement with no ACs at all fires L5", () => {
    const section5 = ["### REQ-005 — Empty criterion", "", "WHEN x, THE system SHALL y."].join(
      "\n",
    );
    const report = lintOf(specMd({ section5 }));
    expect(ofRule(report, "L5")).toHaveLength(1);
  });
});

// ─── L6 ─────────────────────────────────────────────────────────────────────

describe("L6", () => {
  function fourReqSection(): string {
    return [reqBlock(1), reqBlock(2), reqBlock(3), reqBlock(4)].join("\n");
  }

  function fourReqMatrix(): string {
    return [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
      "| REQ-002 | AC-002-1 | task-1 | src/b.test.ts | red |",
      "| REQ-003 | AC-003-1 | task-2 | src/c.test.ts | red |",
      "| REQ-004 | AC-004-1 | task-3 | src/d.test.ts | red |",
    ].join("\n");
  }

  test("AC-003-1: active REQ-004 with no referencing task returns L6 listing REQ-004 [REQ-003]", () => {
    const report = lintOf(specMd({ section5: fourReqSection(), section11: fourReqMatrix() }), {
      tasks: [
        { id: "task-1", reqIds: ["REQ-001", "REQ-002"] },
        { id: "task-2", reqIds: ["REQ-003"] },
      ],
    });
    const findings = ofRule(report, "L6");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("REQ-004");
    expect(findings[0]?.severity).toBe("error");
    expect(report.ok).toBe(false);
  });

  test("[REQ-003] L6: active requirement with no matrix row fires even without task context", () => {
    const section11 = [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
    ].join("\n");
    const report = lintOf(specMd({ section5: fourReqSection(), section11 }));
    const findings = ofRule(report, "L6");
    expect(findings).toHaveLength(3);
    expect(findings[0]?.message).toContain("REQ-002");
    expect(findings[1]?.message).toContain("REQ-003");
    expect(findings[2]?.message).toContain("REQ-004");
  });

  test("[REQ-003] L6: reported once per REQ even when task and matrix references are both missing", () => {
    const section11 = [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
    ].join("\n");
    const report = lintOf(specMd({ section5: fourReqSection(), section11 }), {
      tasks: [{ id: "task-1", reqIds: ["REQ-001"] }],
    });
    const findings = ofRule(report, "L6");
    // REQ-002/003/004 are orphans → one finding each, no double-reporting.
    expect(findings).toHaveLength(3);
    const for002 = findings.filter((f) => f.message.includes("REQ-002"));
    expect(for002).toHaveLength(1);
    expect(for002[0]?.message).toContain("no task referencing it");
    expect(for002[0]?.message).toContain("no traceability matrix row");
  });

  test("[REQ-003] L6: fully referenced active requirements produce no L6", () => {
    const report = lintOf(specMd({ section5: fourReqSection(), section11: fourReqMatrix() }), {
      tasks: [
        { id: "task-1", reqIds: ["REQ-001", "REQ-002"] },
        { id: "task-2", reqIds: ["REQ-003"] },
        { id: "task-3", reqIds: ["REQ-004"] },
      ],
    });
    expect(ofRule(report, "L6")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─── L7 ─────────────────────────────────────────────────────────────────────

describe("L7", () => {
  test("AC-003-2: task reqIds pointing at undefined REQ-999 returns L7 with the task id [REQ-003]", () => {
    const report = lintOf(specMd(), { tasks: [{ id: "task-9", reqIds: ["REQ-999"] }] });
    const findings = ofRule(report, "L7");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("task-9");
    expect(findings[0]?.message).toContain("REQ-999");
    expect(report.ok).toBe(false);
  });

  test("[REQ-003] L7: task referencing a deferred requirement fires L7", () => {
    const section5 = reqBlock(2, { status: "deferred" });
    const section11 = [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
      "| REQ-002 | AC-002-1 | task-9 | src/b.test.ts | red |",
    ].join("\n");
    const report = lintOf(specMd({ section5, section11 }), {
      tasks: [{ id: "task-9", reqIds: ["REQ-002"] }],
    });
    const findings = ofRule(report, "L7");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("deferred");
  });

  test("[REQ-003] L7: tasks referencing existing active requirements produce no L7", () => {
    const report = lintOf(specMd(), { tasks: [{ id: "task-1", reqIds: ["REQ-001"] }] });
    expect(ofRule(report, "L7")).toHaveLength(0);
    expect(report.ok).toBe(true);
  });
});

// ─── L8 ─────────────────────────────────────────────────────────────────────

describe("L8", () => {
  test("[REQ-002] L8: matrix row with empty tests cell is a warning that keeps ok:true", () => {
    const md = specMd({
      section11: [
        "| REQ | AC | Tasks | Tests | state |",
        "|---|---|---|---|---|",
        "| REQ-001 | AC-001-1 | task-1 | src/thing.test.ts | red |",
        "| REQ-001 | AC-001-2 | task-1 |  | red |",
      ].join("\n"),
    });
    const report = lintOf(md);
    const findings = ofRule(report, "L8");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.line).toBe(lineOf(md, "AC-001-2"));
    expect(report.ok).toBe(true);
  });
});

// ─── L9 ─────────────────────────────────────────────────────────────────────

describe("L9", () => {
  const now = new Date("2026-10-04T12:00:00Z");

  test("[REQ-002] L9: implementing spec with updated >30 days before now fires a warning", () => {
    const report = lintOf(specMd({ status: "implementing", updatedValue: "2026-01-01" }), {
      now,
    });
    const findings = ofRule(report, "L9");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("2026-01-01");
    expect(report.ok).toBe(true);
  });

  test("[REQ-002] L9: fires for verified status as well", () => {
    const report = lintOf(specMd({ status: "verified", updatedValue: "2026-08-01" }), { now });
    expect(ofRule(report, "L9")).toHaveLength(1);
  });

  test("[REQ-002] L9: fresh updated or non-implementing status does not fire", () => {
    const fresh = lintOf(specMd({ status: "implementing", updatedValue: "2026-10-01" }), {
      now,
    });
    expect(ofRule(fresh, "L9")).toHaveLength(0);
    const approved = lintOf(specMd({ status: "approved", updatedValue: "2026-01-01" }), { now });
    expect(ofRule(approved, "L9")).toHaveLength(0);
    const draft = lintOf(specMd({ status: "draft", updatedValue: "2026-01-01" }), { now });
    expect(ofRule(draft, "L9")).toHaveLength(0);
  });
});

// ─── Determinism, ordering, stats ───────────────────────────────────────────

describe("report shape", () => {
  test("AC-002-2: two lint runs over a spec with 3 violations return identical JSON [REQ-002]", () => {
    // Exactly three violations: L1 missing owner + L2 missing section 13 + L3 gap REQ-002.
    const section5 = [reqBlock(1), reqBlock(3)].join("\n");
    const section11 = [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
      "| REQ-003 | AC-003-1 | task-2 | src/c.test.ts | red |",
    ].join("\n");
    const md = specMd({
      omitFrontmatterKeys: ["owner"],
      omitSections: [13],
      section5,
      section11,
    });
    const first = lintOf(md);
    const second = lintSpec(parseSpec(md));
    expect(first.findings).toHaveLength(3);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.ok).toBe(false);
  });

  test("[REQ-002] findings are sorted by line, then rule, then message", () => {
    const section5 = [reqBlock(1), reqBlock(3), "### REQ-X9 — Bad id", ""].join("\n");
    const report = lintOf(specMd({ omitFrontmatterKeys: ["owner"], section5 }));
    const sorted = [...report.findings].sort(
      (a, b) =>
        a.line - b.line ||
        (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
        (a.message < b.message ? -1 : a.message > b.message ? 1 : 0),
    );
    expect(report.findings).toEqual(sorted);
    for (let i = 1; i < report.findings.length; i++) {
      const prev = report.findings[i - 1];
      const curr = report.findings[i];
      expect((prev?.line ?? 0) <= (curr?.line ?? 0)).toBe(true);
    }
  });

  test("[REQ-002] warnings do not flip ok; errors do", () => {
    const warningOnly = lintOf(
      specMd({
        section11: [
          "| REQ | AC | Tasks | Tests | state |",
          "|---|---|---|---|---|",
          "| REQ-001 | AC-001-1 | task-1 |  | red |",
        ].join("\n"),
      }),
    );
    expect(warningOnly.findings.every((f) => f.severity === "warning")).toBe(true);
    expect(warningOnly.ok).toBe(true);
    const withError = lintOf(specMd({ omitFrontmatterKeys: ["id"] }));
    expect(withError.ok).toBe(false);
  });

  test("[REQ-003] stats count requirements, ACs and orphan active requirements", () => {
    const section5 = [reqBlock(1), reqBlock(2)].join("\n");
    const section11 = [
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/a.test.ts | red |",
    ].join("\n");
    const report = lintOf(specMd({ section5, section11 }));
    expect(report.stats).toEqual({ reqs: 2, acs: 2, orphans: 1 });
  });

  test("AC-001-1: createSpec → lintSpecFile reports ok:true for a fresh spec [REQ-001]", () => {
    createSpec(projectDir, { slug: "fresh", planId: "plan-1" });
    const report = lintSpecFile(projectDir, "SPEC-001");
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.stats).toEqual({ reqs: 0, acs: 0, orphans: 0 });
  });
});
