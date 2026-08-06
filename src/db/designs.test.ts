/**
 * Tests for design documents (filesystem-backed, no DB).
 *
 * Covers: slug sanitization/validation, date validation, markdown schema,
 * filename building, directory resolution, collision-safe writes, and the
 * full createDesign happy path. Uses a fresh tmp project dir per test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignInput } from "./designs.ts";
import {
  buildDesignFilename,
  createDesign,
  deriveDesignStatus,
  resolveDesignDir,
  sanitizeDesignSlug,
  serializeDesignToMarkdown,
  validateDesignDate,
  validateDesignSlug,
} from "./designs.ts";

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "ndomo-designs-"));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function baseInput(overrides: Partial<DesignInput> = {}): DesignInput {
  return {
    slug: "cache-strategy",
    title: "Caching Strategy",
    problem: "API calls are too slow under load.",
    ...overrides,
  };
}

// ─── Slug sanitization ───────────────────────────────────────────────────────

describe("sanitizeDesignSlug", () => {
  test("lowercases and kebab-cases", () => {
    expect(sanitizeDesignSlug("My Cool Slug")).toBe("my-cool-slug");
  });

  test("strips non-ascii and special chars", () => {
    // 'é', '&', ' ', '!' are all non-[a-z0-9-] → collapsed to a single '-'
    expect(sanitizeDesignSlug("Café & Rest!")).toBe("caf-rest");
  });

  test("defeats path traversal", () => {
    expect(sanitizeDesignSlug("../../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeDesignSlug("..\\..\\win")).toBe("win");
  });

  test("collapses runs and trims edges", () => {
    expect(sanitizeDesignSlug("---a---b---")).toBe("a-b");
  });

  test("empty after sanitize yields empty string", () => {
    expect(sanitizeDesignSlug("!!!")).toBe("");
  });

  test("truncates to max length", () => {
    const long = "a".repeat(200);
    expect(sanitizeDesignSlug(long).length).toBe(80);
  });
});

// ─── Slug validation ─────────────────────────────────────────────────────────

describe("validateDesignSlug", () => {
  test("returns sanitized slug on success", () => {
    expect(validateDesignSlug("My Design")).toBe("my-design");
  });

  test("throws on empty string", () => {
    expect(() => validateDesignSlug("")).toThrow(/cannot be empty/);
  });

  test("throws on whitespace-only", () => {
    expect(() => validateDesignSlug("   ")).toThrow(/cannot be empty/);
  });

  test("throws when sanitizes to empty", () => {
    expect(() => validateDesignSlug("!!!")).toThrow(/sanitizes to empty/);
  });
});

// ─── Date validation ─────────────────────────────────────────────────────────

describe("validateDesignDate", () => {
  test("accepts a valid date", () => {
    expect(validateDesignDate("2026-08-06")).toBe("2026-08-06");
  });

  test("accepts leap day", () => {
    expect(validateDesignDate("2024-02-29")).toBe("2024-02-29");
  });

  test("rejects malformed format", () => {
    expect(() => validateDesignDate("2026/08/06")).toThrow(/YYYY-MM-DD/);
    expect(() => validateDesignDate("2026-8-6")).toThrow(/YYYY-MM-DD/);
    expect(() => validateDesignDate("20260806")).toThrow(/YYYY-MM-DD/);
  });

  test("rejects impossible calendar dates", () => {
    expect(() => validateDesignDate("2026-13-01")).toThrow(/valid calendar date/);
    expect(() => validateDesignDate("2026-02-30")).toThrow(/valid calendar date/);
    expect(() => validateDesignDate("2026-00-10")).toThrow(/valid calendar date/);
  });

  test("rejects non-leap Feb 29", () => {
    expect(() => validateDesignDate("2023-02-29")).toThrow(/valid calendar date/);
  });

  test("rejects path-traversal-shaped input", () => {
    expect(() => validateDesignDate("../../etc")).toThrow(/YYYY-MM-DD/);
  });
});

// ─── Filename building ───────────────────────────────────────────────────────

describe("buildDesignFilename", () => {
  test("produces YYYY-MM-DD-slug-design.md", () => {
    expect(buildDesignFilename("2026-08-06", "my-design")).toBe("2026-08-06-my-design-design.md");
  });
});

// ─── Status derivation ───────────────────────────────────────────────────────

describe("deriveDesignStatus", () => {
  test("proposed when no decision", () => {
    expect(deriveDesignStatus(baseInput())).toBe("proposed");
  });

  test("proposed when blank decision", () => {
    expect(deriveDesignStatus(baseInput({ decision: "   " }))).toBe("proposed");
  });

  test("decided when decision present", () => {
    expect(deriveDesignStatus(baseInput({ decision: "Use Redis" }))).toBe("decided");
  });
});

// ─── Markdown serialization ──────────────────────────────────────────────────

describe("serializeDesignToMarkdown", () => {
  test("includes required sections and frontmatter", () => {
    const md = serializeDesignToMarkdown(baseInput(), "2026-08-06", 1_700_000_000_000);
    expect(md).toContain("# Design: Caching Strategy");
    expect(md).toContain("**Slug:** cache-strategy");
    expect(md).toContain("**Date:** 2026-08-06");
    expect(md).toContain("**Status:** proposed");
    expect(md).toContain("**Author:** foreman");
    expect(md).toContain("## Problem");
    expect(md).toContain("API calls are too slow under load.");
  });

  test("omits optional sections when absent", () => {
    const md = serializeDesignToMarkdown(baseInput(), "2026-08-06", 1_700_000_000_000);
    expect(md).not.toContain("## Goals");
    expect(md).not.toContain("## Constraints");
    expect(md).not.toContain("## Options Considered");
    expect(md).not.toContain("## Decision");
    expect(md).not.toContain("## Consequences");
    expect(md).not.toContain("## Open Questions");
  });

  test("includes plan/session soft refs when provided", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ planId: "plan_abc", sessionId: "ses_xyz" }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("**Plan:** plan_abc");
    expect(md).toContain("**Session:** ses_xyz");
  });

  test("omits plan/session lines when blank", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ planId: "  ", sessionId: "  " }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).not.toContain("**Plan:**");
    expect(md).not.toContain("**Session:**");
  });

  test("renders goals and constraints as bullets", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ goals: ["Speed", "Low cost"], constraints: ["No new deps"] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("## Goals");
    expect(md).toContain("- Speed");
    expect(md).toContain("- Low cost");
    expect(md).toContain("## Constraints");
    expect(md).toContain("- No new deps");
  });

  test("renders options with pros/cons", () => {
    const md = serializeDesignToMarkdown(
      baseInput({
        options: [
          {
            name: "Redis",
            description: "In-memory store",
            pros: ["Fast"],
            cons: ["Extra infra"],
          },
        ],
      }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("## Options Considered");
    expect(md).toContain("### Redis");
    expect(md).toContain("In-memory store");
    expect(md).toContain("**Pros:**");
    expect(md).toContain("- Fast");
    expect(md).toContain("**Cons:**");
    expect(md).toContain("- Extra infra");
  });

  test("decision flips status to decided", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ decision: "Use Redis with TTL" }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("**Status:** decided");
    expect(md).toContain("## Decision");
    expect(md).toContain("Use Redis with TTL");
  });

  test("filters blank bullets", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ goals: ["Real", "  ", ""] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("- Real");
    // No empty bullet lines
    expect(md).not.toMatch(/^- $/m);
  });
});

// ─── Phase 0 sections: scope / exclusions / trade-offs ───────────────────────

describe("serializeDesignToMarkdown — Phase 0 sections", () => {
  test("renders scope as bullets", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ scope: ["Auth layer", "Token issuance"] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("## Scope");
    expect(md).toContain("- Auth layer");
    expect(md).toContain("- Token issuance");
  });

  test("renders exclusions as bullets", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ exclusions: ["Billing", "SSO providers"] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("## Exclusions");
    expect(md).toContain("- Billing");
    expect(md).toContain("- SSO providers");
  });

  test("renders trade-offs as bullets", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ decision: "X", tradeoffs: ["Simplicity over perf", "No vendor lock-in"] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).toContain("## Trade-offs");
    expect(md).toContain("- Simplicity over perf");
    expect(md).toContain("- No vendor lock-in");
  });

  test("omits scope/exclusions/trade-offs when absent", () => {
    const md = serializeDesignToMarkdown(baseInput(), "2026-08-06", 1_700_000_000_000);
    expect(md).not.toContain("## Scope");
    expect(md).not.toContain("## Exclusions");
    expect(md).not.toContain("## Trade-offs");
  });

  test("omits Phase 0 sections when arrays are empty or blank-only", () => {
    const md = serializeDesignToMarkdown(
      baseInput({ scope: [], exclusions: ["  "], tradeoffs: [""] }),
      "2026-08-06",
      1_700_000_000_000,
    );
    expect(md).not.toContain("## Scope");
    expect(md).not.toContain("## Exclusions");
    expect(md).not.toContain("## Trade-offs");
  });

  test("section order: Scope/Exclusions after Constraints, before Options", () => {
    const md = serializeDesignToMarkdown(
      baseInput({
        constraints: ["c1"],
        scope: ["s1"],
        exclusions: ["e1"],
        options: [{ name: "OptA" }],
      }),
      "2026-08-06",
      1_700_000_000_000,
    );
    const idxConstraints = md.indexOf("## Constraints");
    const idxScope = md.indexOf("## Scope");
    const idxExclusions = md.indexOf("## Exclusions");
    const idxOptions = md.indexOf("## Options Considered");
    expect(idxConstraints).toBeGreaterThan(-1);
    expect(idxScope).toBeGreaterThan(idxConstraints);
    expect(idxExclusions).toBeGreaterThan(idxScope);
    expect(idxOptions).toBeGreaterThan(idxExclusions);
  });

  test("section order: Trade-offs after Decision, before Consequences", () => {
    const md = serializeDesignToMarkdown(
      baseInput({
        decision: "Decide X",
        tradeoffs: ["t1"],
        consequences: ["con1"],
      }),
      "2026-08-06",
      1_700_000_000_000,
    );
    const idxDecision = md.indexOf("## Decision");
    const idxTradeoffs = md.indexOf("## Trade-offs");
    const idxConsequences = md.indexOf("## Consequences");
    expect(idxDecision).toBeGreaterThan(-1);
    expect(idxTradeoffs).toBeGreaterThan(idxDecision);
    expect(idxConsequences).toBeGreaterThan(idxTradeoffs);
  });

  test("full Phase 0 rich doc writes all new sections end-to-end", () => {
    const result = createDesign(projectDir, {
      slug: "phase0-design",
      title: "Phase 0 Rich Doc",
      problem: "Need full Phase 0 capture.",
      goals: ["G1"],
      constraints: ["C1"],
      scope: ["S1"],
      exclusions: ["E1"],
      options: [{ name: "Opt", pros: ["p"] }],
      decision: "Pick Opt",
      tradeoffs: ["T1"],
      consequences: ["Con1"],
      openQuestions: ["Q1"],
      date: "2024-01-15",
    });
    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain("## Scope");
    expect(content).toContain("- S1");
    expect(content).toContain("## Exclusions");
    expect(content).toContain("- E1");
    expect(content).toContain("## Trade-offs");
    expect(content).toContain("- T1");
    expect(result.status).toBe("decided");
  });
});

// ─── Directory resolution ────────────────────────────────────────────────────

describe("resolveDesignDir", () => {
  test("returns .ndomo/designs under projectDir and creates it", () => {
    const dir = resolveDesignDir(projectDir);
    expect(dir).toBe(join(projectDir, ".ndomo", "designs"));
    expect(existsSync(dir)).toBe(true);
  });

  test("idempotent — safe to call twice", () => {
    const a = resolveDesignDir(projectDir);
    const b = resolveDesignDir(projectDir);
    expect(a).toBe(b);
    expect(existsSync(b)).toBe(true);
  });
});

// ─── createDesign (filesystem write) ─────────────────────────────────────────

describe("createDesign", () => {
  test("writes a markdown file and returns metadata", () => {
    const result = createDesign(projectDir, baseInput());

    expect(result.slug).toBe("cache-strategy");
    expect(result.title).toBe("Caching Strategy");
    expect(result.status).toBe("proposed");
    expect(result.filePath).toBe(join(projectDir, ".ndomo", "designs", result.filename));
    expect(result.filename).toMatch(/^\d{4}-\d{2}-\d{2}-cache-strategy-design\.md$/);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(existsSync(result.filePath)).toBe(true);

    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain("# Design: Caching Strategy");
    expect(content).toContain("## Problem");
  });

  test("uses provided date override in filename", () => {
    const result = createDesign(projectDir, baseInput({ date: "2024-01-15" }));
    expect(result.date).toBe("2024-01-15");
    expect(result.filename).toBe("2024-01-15-cache-strategy-design.md");
  });

  test("sanitizes slug in filename", () => {
    const result = createDesign(projectDir, baseInput({ slug: "My Cool Design!" }));
    expect(result.slug).toBe("my-cool-design");
    expect(result.filename).toMatch(/my-cool-design-design\.md$/);
  });

  test("resolves collisions with numeric suffix", () => {
    const r1 = createDesign(projectDir, baseInput({ date: "2024-01-15" }));
    const r2 = createDesign(projectDir, baseInput({ date: "2024-01-15" }));
    const r3 = createDesign(projectDir, baseInput({ date: "2024-01-15" }));

    expect(r1.filename).toBe("2024-01-15-cache-strategy-design.md");
    expect(r2.filename).toBe("2024-01-15-cache-strategy-design-2.md");
    expect(r3.filename).toBe("2024-01-15-cache-strategy-design-3.md");
    expect(existsSync(r1.filePath)).toBe(true);
    expect(existsSync(r2.filePath)).toBe(true);
    expect(existsSync(r3.filePath)).toBe(true);
  });

  test("never overwrites an existing file", () => {
    const r1 = createDesign(projectDir, baseInput({ date: "2024-01-15" }));
    const original = readFileSync(r1.filePath, "utf-8");
    // Second create with same slug+date must NOT clobber the first
    createDesign(projectDir, baseInput({ date: "2024-01-15" }));
    expect(readFileSync(r1.filePath, "utf-8")).toBe(original);
  });

  test("throws on empty slug", () => {
    expect(() => createDesign(projectDir, baseInput({ slug: "" }))).toThrow(/cannot be empty/);
  });

  test("throws on slug that sanitizes to empty", () => {
    expect(() => createDesign(projectDir, baseInput({ slug: "!!!" }))).toThrow(
      /sanitizes to empty/,
    );
  });

  test("throws on empty title", () => {
    expect(() => createDesign(projectDir, baseInput({ title: "  " }))).toThrow(
      /title cannot be empty/,
    );
  });

  test("throws on empty problem", () => {
    expect(() => createDesign(projectDir, baseInput({ problem: "" }))).toThrow(
      /problem cannot be empty/,
    );
  });

  test("throws on invalid date override", () => {
    expect(() => createDesign(projectDir, baseInput({ date: "2026-13-40" }))).toThrow(
      /valid calendar date/,
    );
  });

  test("blocks path traversal via slug", () => {
    // A traversal-shaped slug must NOT escape the designs dir
    const result = createDesign(projectDir, baseInput({ slug: "../../../etc/evil" }));
    expect(result.filePath.startsWith(resolveDesignDir(projectDir))).toBe(true);
    expect(result.slug).toBe("etc-evil");
    expect(result.filePath).not.toContain("..");
  });

  test("full rich document writes all sections", () => {
    const result = createDesign(projectDir, {
      slug: "auth-flow",
      title: "Auth Flow",
      problem: "Need secure auth.",
      goals: ["Secure", "Fast"],
      constraints: ["No vendor lock-in"],
      options: [
        { name: "JWT", pros: ["Stateless"], cons: ["Revocation hard"] },
        { name: "Sessions", pros: ["Easy revoke"], cons: ["Needs store"] },
      ],
      decision: "JWT with short TTL + refresh",
      consequences: ["Need refresh endpoint", "Clock skew matters"],
      openQuestions: ["Key rotation strategy?"],
      planId: "plan_1",
      sessionId: "ses_1",
      agent: "foreman",
      date: "2024-01-15",
    });

    const content = readFileSync(result.filePath, "utf-8");
    expect(content).toContain("**Status:** decided");
    expect(content).toContain("## Goals");
    expect(content).toContain("## Constraints");
    expect(content).toContain("### JWT");
    expect(content).toContain("### Sessions");
    expect(content).toContain("## Decision");
    expect(content).toContain("## Consequences");
    expect(content).toContain("## Open Questions");
    expect(content).toContain("**Plan:** plan_1");
    expect(content).toContain("**Session:** ses_1");
    expect(result.status).toBe("decided");
  });
});
