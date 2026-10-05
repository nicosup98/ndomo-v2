/**
 * Tests for the spec module: template, create, parse, serialize and path helpers.
 *
 * TDD red-proof: every test carries its REQ/AC tag so the traceability matrix
 * (SPEC-001 §11) stays honest. Fixtures are inline strings and temp dirs only —
 * nothing in this file ever writes into `.ndomo/`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpecDirName,
  buildSpecTemplate,
  createSpec,
  lintSpecFile,
  nextSpecIndex,
  parseSpec,
  resolveSpecPath,
  resolveSpecsDir,
  serializeSpec,
} from "./index.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "spec-module-"));
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

function reqBlock(n: number, opts: { status?: string; gwt?: boolean } = {}): string {
  const id = `REQ-${String(n).padStart(3, "0")}`;
  const acNum = String(n).padStart(3, "0");
  const status = opts.status ?? "active";
  const ac =
    opts.gwt === false
      ? `- AC-${acNum}-1: covers the happy path.`
      : `- AC-${acNum}-1: **Given** a precondition, **When** an action, **Then** an outcome.`;
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
  omitSections?: number[];
  section1?: string;
  section5?: string;
  section11?: string;
  section12?: string;
}

/** Build a canonical, lint-clean spec document (single blank line between blocks). */
function specMd(opts: SpecMdOptions = {}): string {
  const omit = new Set(opts.omitSections ?? []);
  const parts: string[] = [
    "---",
    "id: SPEC-007",
    "slug: fixture",
    "title: Fixture Spec",
    `status: ${opts.status ?? "draft"}`,
    "version: 1.0",
    "owner: tester",
    "created: 2026-10-01",
    "updated: 2026-10-01",
    "related_plans:",
    "  - plan-aaa",
    "related_designs: []",
    "supersedes: null",
    ...(opts.extraFrontmatter ?? []),
    "---",
    "",
    "# SPEC-007 Fixture Spec",
    "",
  ];
  const bodies: Record<number, string> = {
    1: opts.section1 ?? "Why this fixture exists.",
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

/** Line number (1-based) of the first line matching `needle`. */
function lineOf(md: string, needle: string): number {
  return md.split("\n").findIndex((l) => l.includes(needle)) + 1;
}

// ─── REQ-001: scaffold / createSpec / template ──────────────────────────────

describe("REQ-001 scaffold", () => {
  test("AC-001-1: createSpec writes .ndomo/specs/001-<slug>/spec.md with 3-digit NNN [REQ-001]", () => {
    const result = createSpec(projectDir, { slug: "foo" });
    expect(result.id).toBe("SPEC-001");
    expect(result.slug).toBe("foo");
    expect(result.created).toBe(true);
    expect(result.path.endsWith(join(".ndomo", "specs", "001-foo", "spec.md"))).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    const doc = parseSpec(readFileSync(result.path, "utf8"));
    expect(doc.frontmatter.id).toBe("SPEC-001");
    expect(doc.frontmatter.slug).toBe("foo");
    expect(doc.sections.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  test("AC-001-1: second createSpec increments the index to 002 and SPEC-002 [REQ-001]", () => {
    createSpec(projectDir, { slug: "foo" });
    const second = createSpec(projectDir, { slug: "bar" });
    expect(second.id).toBe("SPEC-002");
    expect(second.path.endsWith(join("002-bar", "spec.md"))).toBe(true);
  });

  test("AC-001-2: duplicate slug throws without overwriting and reports the existing path [REQ-001]", () => {
    const first = createSpec(projectDir, { slug: "foo" });
    const before = readFileSync(first.path, "utf8");
    let message = "";
    try {
      createSpec(projectDir, { slug: "foo" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(first.path);
    // No overwrite: original bytes intact, no second dir with the same slug.
    expect(readFileSync(first.path, "utf8")).toBe(before);
    expect(existsSync(join(projectDir, ".ndomo", "specs", "002-foo"))).toBe(false);
  });

  test("AC-001-2: a slug already on disk at a different index is still rejected [REQ-001]", () => {
    const specsDir = resolveSpecsDir(projectDir);
    mkdirSync(join(specsDir, "004-foo"), { recursive: true });
    writeFileSync(join(specsDir, "004-foo", "spec.md"), specMd(), "utf8");
    expect(() => createSpec(projectDir, { slug: "foo" })).toThrow("004-foo");
  });

  test("AC-001-2: stale directory with the slug never yields a second dir or an overwrite [REQ-001]", () => {
    const specsDir = resolveSpecsDir(projectDir);
    mkdirSync(join(specsDir, "001-foo"), { recursive: true });
    let message = "";
    try {
      createSpec(projectDir, { slug: "foo" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("001-foo");
    expect(existsSync(join(specsDir, "001-foo", "spec.md"))).toBe(false);
  });

  test("[REQ-001] createSpec returns an absolute path and a byteSize matching the file", () => {
    const result = createSpec(projectDir, { slug: "bytes" });
    expect(result.path.startsWith("/")).toBe(true);
    const bytes = readFileSync(result.path).byteLength;
    expect(result.byteSize).toBe(bytes);
    expect(result.byteSize).toBeGreaterThan(0);
  });

  test("[REQ-001] createSpec validates the date strictly and rejects malformed dates", () => {
    expect(createSpec(projectDir, { slug: "dated", date: "2026-10-04" }).path).toBeTruthy();
    expect(() => createSpec(projectDir, { slug: "bad-date", date: "yesterday" })).toThrow(
      "YYYY-MM-DD",
    );
    expect(() => createSpec(projectDir, { slug: "bad-date", date: "2026-13-45" })).toThrow(
      "not a valid calendar date",
    );
  });

  test("[REQ-001] createSpec writes owner from agent, defaulting to unknown, plus plan linkage", () => {
    const withAgent = createSpec(projectDir, { slug: "owned", agent: "craftsman" });
    const owned = parseSpec(readFileSync(withAgent.path, "utf8"));
    expect(owned.frontmatter.owner).toBe("craftsman");
    expect(owned.frontmatter.status).toBe("draft");
    expect(owned.frontmatter.version).toBe("1.0");

    const fallback = createSpec(projectDir, { slug: "no-owner" });
    const doc = parseSpec(readFileSync(fallback.path, "utf8"));
    expect(doc.frontmatter.owner).toBe("unknown");
    expect(doc.frontmatter.related_plans).toEqual([]);

    const planned = createSpec(projectDir, { slug: "planned", planId: "plan-123" });
    const plannedDoc = parseSpec(readFileSync(planned.path, "utf8"));
    expect(plannedDoc.frontmatter.related_plans).toEqual(["plan-123"]);
  });

  test("[REQ-001] buildSpecTemplate emits all 13 sections in canonical order with 11 required keys", () => {
    const md = buildSpecTemplate({ index: 1, slug: "demo", date: "2026-10-04" });
    const doc = parseSpec(md);
    expect(doc.sections.map((s) => s.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const key of [
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
    ]) {
      expect(key in doc.frontmatter).toBe(true);
    }
    expect(doc.frontmatter.id).toBe("SPEC-001");
    expect(doc.frontmatter.created).toBe("2026-10-04");
    expect(doc.frontmatter.updated).toBe("2026-10-04");
  });

  test("[REQ-001] template placeholders do not create phantom REQs or matrix rows (fences ignored)", () => {
    const doc = parseSpec(buildSpecTemplate({ index: 3, slug: "phantom" }));
    expect(doc.requirements).toEqual([]);
    expect(doc.matrix).toEqual([]);
    // The fenced examples still document the format for humans.
    expect(doc.raw).toContain("### REQ-001 — Example requirement");
    expect(doc.raw).toContain("| REQ | AC | Tasks | Tests | state |");
  });

  test("[REQ-001] template title falls back to title-case of the slug; explicit title wins", () => {
    const derived = parseSpec(buildSpecTemplate({ index: 1, slug: "my-thing" }));
    expect(derived.frontmatter.title).toBe("My Thing");
    const explicit = parseSpec(
      buildSpecTemplate({ index: 1, slug: "my-thing", title: "Custom Title" }),
    );
    expect(explicit.frontmatter.title).toBe("Custom Title");
  });

  test("AC-001-1: createSpec output lints ok:true through lintSpecFile [REQ-001]", () => {
    const result = createSpec(projectDir, { slug: "clean" });
    const report = lintSpecFile(projectDir, "001-clean");
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.stats.reqs).toBe(0);
    expect(report.stats.acs).toBe(0);
    expect(result.created).toBe(true);
  });

  test("[REQ-001] nextSpecIndex returns 1 on empty/missing dirs and max+1 otherwise", () => {
    const specsDir = resolveSpecsDir(projectDir);
    expect(nextSpecIndex(specsDir)).toBe(1);
    expect(nextSpecIndex(join(projectDir, ".ndomo", "does-not-exist"))).toBe(1);
    mkdirSync(join(specsDir, "001-alpha"));
    mkdirSync(join(specsDir, "007-beta"));
    mkdirSync(join(specsDir, "not-a-spec"));
    expect(nextSpecIndex(specsDir)).toBe(8);
    expect(buildSpecDirName(1, "alpha")).toBe("001-alpha");
    expect(buildSpecDirName(42, "alpha")).toBe("042-alpha");
    expect(buildSpecDirName(1000, "alpha")).toBe("1000-alpha");
  });
});

// ─── Parser ─────────────────────────────────────────────────────────────────

describe("parseSpec", () => {
  test("[REQ-002] parses frontmatter scalars, YAML lists, empty lists and unknown keys", () => {
    const doc = parseSpec(specMd({ extraFrontmatter: ["related_tools:", "  - spec_lint"] }));
    expect(doc.frontmatter.id).toBe("SPEC-007");
    expect(doc.frontmatter.status).toBe("draft");
    expect(doc.frontmatter.related_plans).toEqual(["plan-aaa"]);
    expect(doc.frontmatter.related_designs).toEqual([]);
    expect(doc.frontmatter.supersedes).toBe("null");
    expect(doc.frontmatter.related_tools).toEqual(["spec_lint"]);
  });

  test("[REQ-002] parses requirement meta from the single-line '·' form and the '**Key**' form", () => {
    const section5 = [
      reqBlock(1),
      "### REQ-002 — Second requirement",
      "",
      "WHEN x, THE system SHALL y.",
      "",
      "- AC-002-1: **Given** a state, **When** an event, **Then** a result.",
      "- **Type**: functional",
      "- **Priority**: MUST",
      "- **Owner**: alice",
      "- **Status**: deferred",
    ].join("\n");
    const doc = parseSpec(specMd({ section5 }));
    expect(doc.requirements.map((r) => r.id)).toEqual(["REQ-001", "REQ-002"]);
    const first = doc.requirements[0];
    expect(first?.title).toBe("Requirement 1");
    expect(first?.type).toBe("ubiq");
    expect(first?.priority).toBe("P1");
    expect(first?.owner).toBe("tester");
    expect(first?.status).toBe("active");
    const second = doc.requirements[1];
    expect(second?.type).toBe("functional");
    expect(second?.priority).toBe("MUST");
    expect(second?.owner).toBe("alice");
    expect(second?.status).toBe("deferred");
    expect(second?.acs).toHaveLength(1);
  });

  test("[REQ-002] requirement status defaults to active when no Status bullet is present", () => {
    const section5 = [
      "### REQ-009 — No meta at all",
      "",
      "WHEN x, THE system SHALL y.",
      "",
      "- AC-009-1: **Given** a, **When** b, **Then** c.",
    ].join("\n");
    const doc = parseSpec(specMd({ section5 }));
    expect(doc.requirements[0]?.status).toBe("active");
    expect(doc.requirements[0]?.type).toBeUndefined();
  });

  test("[REQ-002] extracts AC Given/When/Then including multi-line continuation", () => {
    const section5 = [
      "### REQ-001 — First requirement",
      "",
      "WHEN a request arrives, THE system SHALL respond.",
      "",
      "- AC-001-1: **Given** `.ndomo/specs/001-foo/spec.md` exists, **When** creating slug `bar`,",
      "  **Then** it creates `002-bar/spec.md` with `id: SPEC-002`.",
    ].join("\n");
    const doc = parseSpec(specMd({ section5 }));
    const req = doc.requirements[0];
    const ac = req?.acs[0];
    expect(ac?.id).toBe("AC-001-1");
    expect(ac?.given).toContain("001-foo/spec.md");
    expect(ac?.when).toContain("creating slug");
    expect(ac?.then).toContain("002-bar/spec.md");
    expect(ac && req ? ac.line > req.line : false).toBe(true);
  });

  test("[REQ-002] records section lines, bodies and endLine", () => {
    const md = specMd();
    const doc = parseSpec(md);
    const purpose = doc.sections[0];
    const headingLine = lineOf(md, "## 1. Purpose");
    expect(headingLine).toBeGreaterThan(0);
    expect(purpose?.number).toBe(1);
    expect(purpose?.title).toBe("Purpose");
    expect(purpose?.line).toBe(headingLine);
    expect(purpose?.startLine).toBe(headingLine);
    expect(purpose?.body).toBe("Why this fixture exists.");
    expect(purpose?.endLine).toBe(headingLine + 2);
    for (const section of doc.sections) {
      expect(section.line).toBeGreaterThan(0);
      expect(section.endLine).toBeGreaterThanOrEqual(section.line);
    }
  });

  test("[REQ-003] parses the section 11 traceability matrix into SpecMatrixRow rows", () => {
    const section11 = [
      "Intro line before the table.",
      "",
      "| REQ | AC | Tasks | Tests | state |",
      "|---|---|---|---|---|",
      "| REQ-001 | AC-001-1 | task-1 | src/thing.test.ts | red |",
      "| REQ-001 | AC-001-2 | task-1 | src/thing.test.ts | green |",
      "",
      "Trailing prose after the table.",
    ].join("\n");
    const doc = parseSpec(specMd({ section11 }));
    expect(doc.matrix).toHaveLength(2);
    const first = doc.matrix[0];
    expect(first?.req).toBe("REQ-001");
    expect(first?.ac).toBe("AC-001-1");
    expect(first?.tasks).toBe("task-1");
    expect(first?.tests).toBe("src/thing.test.ts");
    expect(first?.state).toBe("red");
    expect(doc.matrix[1]?.state).toBe("green");
    expect(doc.matrix[1]?.line).toBe((first?.line ?? 0) + 1);
  });

  test("[REQ-001] parser ignores fenced code blocks when scanning section, REQ and matrix headings", () => {
    const fenceOpen = "```markdown";
    const fenceClose = "```";
    const md = specMd({
      section1: ["Why this fixture exists.", fenceOpen, "## 99. Phantom Section", fenceClose].join(
        "\n",
      ),
      section5: [
        reqBlock(1),
        fenceOpen,
        "### REQ-999 — Phantom requirement",
        "### REQ-998 — Also phantom",
        fenceClose,
      ].join("\n"),
      section11: [
        "| REQ | AC | Tasks | Tests | state |",
        "|---|---|---|---|---|",
        "| REQ-001 | AC-001-1 | task-1 | src/thing.test.ts | red |",
        fenceOpen,
        "| REQ-999 | AC-999-1 | task-9 | ghost.test.ts | red |",
        fenceClose,
      ].join("\n"),
    });
    const doc = parseSpec(md);
    expect(doc.sections.map((s) => s.number)).not.toContain(99);
    expect(doc.requirements.map((r) => r.id)).not.toContain("REQ-999");
    expect(doc.requirements.map((r) => r.id)).not.toContain("REQ-998");
    expect(doc.matrix.every((row) => row.req !== "REQ-999")).toBe(true);
    // Sanity: the real REQ/rows still parse.
    expect(doc.requirements.map((r) => r.id)).toContain("REQ-001");
    expect(doc.matrix).toHaveLength(1);
  });
});

// ─── resolveSpecPath ────────────────────────────────────────────────────────

describe("resolveSpecPath", () => {
  test("[REQ-002] resolves SPEC-id via frontmatter scan of .ndomo/specs/*/spec.md", () => {
    const result = createSpec(projectDir, { slug: "sdd-core" });
    const byId = resolveSpecPath(projectDir, "SPEC-001");
    expect(byId).toBe(result.path);
  });

  test("[REQ-002] resolves NNN-slug, NNN-slug/spec.md, project-relative and absolute paths", () => {
    const result = createSpec(projectDir, { slug: "sdd-core" });
    expect(resolveSpecPath(projectDir, "001-sdd-core")).toBe(result.path);
    expect(resolveSpecPath(projectDir, "001-sdd-core/spec.md")).toBe(result.path);
    expect(resolveSpecPath(projectDir, ".ndomo/specs/001-sdd-core/spec.md")).toBe(result.path);
    expect(resolveSpecPath(projectDir, result.path)).toBe(result.path);
  });

  test("[REQ-002] returns null for unknown ids and paths and never throws", () => {
    createSpec(projectDir, { slug: "present" });
    expect(resolveSpecPath(projectDir, "SPEC-999")).toBeNull();
    expect(resolveSpecPath(projectDir, "002-absent")).toBeNull();
    expect(resolveSpecPath(projectDir, "002-absent/spec.md")).toBeNull();
    expect(resolveSpecPath(projectDir, "totally bogus value")).toBeNull();
    expect(resolveSpecPath(projectDir, "")).toBeNull();
    expect(resolveSpecPath(projectDir, "/nonexistent/abs/path/spec.md")).toBeNull();
  });
});

// ─── serializeSpec ──────────────────────────────────────────────────────────

describe("serializeSpec", () => {
  test("[REQ-001] round-trip preserves frontmatter, sections, requirements and matrix", () => {
    const doc = parseSpec(specMd({ section5: [reqBlock(1), reqBlock(2)].join("\n") }));
    const roundTripped = parseSpec(serializeSpec(doc));
    expect(roundTripped.frontmatter).toEqual(doc.frontmatter);
    expect(roundTripped.sections).toEqual(doc.sections);
    expect(roundTripped.requirements).toEqual(doc.requirements);
    expect(roundTripped.matrix).toEqual(doc.matrix);
  });

  test("[REQ-001] serializes frontmatter in canonical key order with sections ascending", () => {
    const out = serializeSpec(parseSpec(specMd()));
    const keys = [
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
    ];
    const positions = keys.map((k) => out.indexOf(`\n${k}:`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < positions.length; i++) {
      const prev = positions[i - 1] ?? -1;
      const curr = positions[i] ?? -2;
      expect(curr > prev).toBe(true);
    }
    expect(out.startsWith("---\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    const headingPositions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((n) =>
      out.indexOf(`\n## ${n}. `),
    );
    expect(headingPositions.every((p) => p >= 0)).toBe(true);
    for (let i = 1; i < headingPositions.length; i++) {
      const prev = headingPositions[i - 1] ?? -1;
      const curr = headingPositions[i] ?? -2;
      expect(curr > prev).toBe(true);
    }
  });

  test("[REQ-001] canonicalizes a reversed sections array into ascending numeric order", () => {
    const doc = parseSpec(specMd());
    const reordered = { ...doc, sections: [...doc.sections].reverse() };
    const out = serializeSpec(reordered);
    let last = 0;
    for (const line of out.split("\n")) {
      const m = /^## (\d+)\. /.exec(line);
      if (m) {
        const n = Number(m[1]);
        expect(n).toBeGreaterThan(last);
        last = n;
      }
    }
    expect(last).toBe(13);
  });

  test("[REQ-001] preserves the preamble (title line) through a serialize round-trip", () => {
    const doc = parseSpec(specMd());
    const out = serializeSpec(doc);
    expect(out).toContain("# SPEC-007 Fixture Spec");
    const roundTripped = parseSpec(out);
    expect(roundTripped.sections).toEqual(doc.sections);
  });
});
