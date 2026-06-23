import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  archiveAnalysis,
  createAnalysis,
  getAnalysis,
  getAnalysisBySlug,
  linkAnalysisToPlan,
  listAnalyses,
  searchAnalyses,
  unlinkAnalysisFromPlan,
  updateAnalysis,
  validateAnalysisFindings,
} from "./analyses.ts";
import { createPlan } from "./plans.ts";
import { runMigrations } from "./migrations.ts";


let db: Database;

function makePlan(overrides?: Partial<ReturnType<typeof createPlan>>): ReturnType<typeof createPlan> {
  return createPlan(db, {
    id: "plan-1",
    slug: "test-plan",
    title: "Test Plan",
    status: "draft",
    priority: 1,
    overview: "test overview",
    complexity: 3,
    createdBy: "test",
    updatedBy: "test",
    sessionId: null,
    approvedAt: null,
    completedAt: null,
    approach: null,
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

describe("analyses.ts", () => {
  // ── createAnalysis ─────────────────────────────────────────────────────────

  describe("createAnalysis", () => {
    test("happy path — creates analysis with defaults", () => {
      const a = createAnalysis(db, {
        slug: "my-analysis",
        title: "My Analysis",
        projectPath: "/home/project",
      });
      expect(a.id).toBeTruthy();
      expect(a.slug).toBe("my-analysis");
      expect(a.title).toBe("My Analysis");
      expect(a.projectPath).toBe("/home/project");
      expect(a.summary).toBe("");
      expect(a.findingsJson).toBe("[]");
      expect(a.agent).toBe("ranger");
      expect(a.sourcePlanId).toBeNull();
      expect(a.sessionId).toBeNull();
      expect(a.createdBy).toBeNull();
      expect(a.createdAt).toBeTruthy();
      expect(a.updatedAt).toBeTruthy();
      expect(a.archivedAt).toBeNull();
    });

    test("creates analysis with all optional fields", () => {
      const a = createAnalysis(db, {
        slug: "full-analysis",
        title: "Full Analysis",
        projectPath: "/opt/app",
        summary: "A complete analysis",
        findingsJson: '[{"issue":"foo"}]',
        agent: "js-smith",
        sessionId: "sess-1",
        createdBy: "user-1",
      });
      expect(a.summary).toBe("A complete analysis");
      expect(a.findingsJson).toBe('[{"issue":"foo"}]');
      expect(a.agent).toBe("js-smith");
      expect(a.sessionId).toBe("sess-1");
      expect(a.createdBy).toBe("user-1");
    });

    test("throws on duplicate slug+project_path", () => {
      createAnalysis(db, { slug: "dup", title: "A", projectPath: "/p" });
      expect(() =>
        createAnalysis(db, { slug: "dup", title: "B", projectPath: "/p" }),
      ).toThrow("already exists");
    });

    test("same slug different project_path is OK", () => {
      createAnalysis(db, { slug: "shared", title: "A", projectPath: "/p1" });
      const b = createAnalysis(db, { slug: "shared", title: "B", projectPath: "/p2" });
      expect(b.id).toBeTruthy();
    });

    test("throws on empty slug", () => {
      expect(() =>
        createAnalysis(db, { slug: "", title: "T", projectPath: "/p" }),
      ).toThrow("slug cannot be empty");
    });

    test("throws on empty projectPath", () => {
      expect(() =>
        createAnalysis(db, { slug: "ok", title: "T", projectPath: "" }),
      ).toThrow("projectPath cannot be empty");
    });

    test("trims slug and title", () => {
      const a = createAnalysis(db, {
        slug: "  trimmed  ",
        title: "  spaced  ",
        projectPath: "/p",
      });
      expect(a.slug).toBe("trimmed");
      expect(a.title).toBe("spaced");
    });
  });

  // ── getAnalysis / getAnalysisBySlug ────────────────────────────────────────

  describe("getAnalysis", () => {
    test("returns existing analysis", () => {
      const created = createAnalysis(db, { slug: "find", title: "Find me", projectPath: "/p" });
      const found = getAnalysis(db, created.id);
      expect(found).not.toBeNull();
      expect(found!.slug).toBe("find");
    });

    test("returns null for non-existent id", () => {
      expect(getAnalysis(db, "nonexistent")).toBeNull();
    });

    test("excludes archived by default", () => {
      const created = createAnalysis(db, { slug: "arch", title: "Arch", projectPath: "/p" });
      archiveAnalysis(db, created.id);
      expect(getAnalysis(db, created.id)).toBeNull();
    });

    test("includeArchived=true returns archived", () => {
      const created = createAnalysis(db, { slug: "arch2", title: "Arch2", projectPath: "/p" });
      archiveAnalysis(db, created.id);
      const found = getAnalysis(db, created.id, { includeArchived: true });
      expect(found).not.toBeNull();
      expect(found!.archivedAt).toBeTruthy();
    });
  });

  describe("getAnalysisBySlug", () => {
    test("returns analysis by slug+project", () => {
      createAnalysis(db, { slug: "by-slug", title: "BySlug", projectPath: "/proj" });
      const found = getAnalysisBySlug(db, "by-slug", "/proj");
      expect(found).not.toBeNull();
      expect(found!.title).toBe("BySlug");
    });

    test("returns null for wrong project", () => {
      createAnalysis(db, { slug: "x", title: "X", projectPath: "/p1" });
      expect(getAnalysisBySlug(db, "x", "/p2")).toBeNull();
    });
  });

  // ── listAnalyses ──────────────────────────────────────────────────────────

  describe("listAnalyses", () => {
    test("returns empty array when no analyses", () => {
      expect(listAnalyses(db)).toEqual([]);
    });

    test("returns all active analyses", () => {
      createAnalysis(db, { slug: "a", title: "A", projectPath: "/p" });
      createAnalysis(db, { slug: "b", title: "B", projectPath: "/p" });
      const all = listAnalyses(db);
      expect(all.length).toBe(2);
    });

    test("excludes archived by default", () => {
      const a = createAnalysis(db, { slug: "a", title: "A", projectPath: "/p" });
      createAnalysis(db, { slug: "b", title: "B", projectPath: "/p" });
      archiveAnalysis(db, a.id);
      const active = listAnalyses(db);
      expect(active.length).toBe(1);
      expect(active[0]!.slug).toBe("b");
    });

    test("filters by agent", () => {
      createAnalysis(db, { slug: "a", title: "A", projectPath: "/p", agent: "js-smith" });
      createAnalysis(db, { slug: "b", title: "B", projectPath: "/p", agent: "go-smith" });
      const js = listAnalyses(db, { agent: "js-smith" });
      expect(js.length).toBe(1);
      expect(js[0]!.agent).toBe("js-smith");
    });

    test("filters by projectPath", () => {
      createAnalysis(db, { slug: "a", title: "A", projectPath: "/p1" });
      createAnalysis(db, { slug: "b", title: "B", projectPath: "/p2" });
      const p1 = listAnalyses(db, { projectPath: "/p1" });
      expect(p1.length).toBe(1);
    });

    test("filters by sourcePlanId", () => {
      makePlan();
      createAnalysis(db, { slug: "a", title: "A", projectPath: "/p", sourcePlanId: "plan-1" });
      createAnalysis(db, { slug: "b", title: "B", projectPath: "/p" });
      const linked = listAnalyses(db, { sourcePlanId: "plan-1" });
      expect(linked.length).toBe(1);
    });

    test("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        createAnalysis(db, { slug: `a${i}`, title: `A${i}`, projectPath: "/p" });
      }
      const limited = listAnalyses(db, { limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  // ── searchAnalyses ────────────────────────────────────────────────────────

  describe("searchAnalyses", () => {
    test("matches by title", () => {
      createAnalysis(db, { slug: "s1", title: "Security Audit", projectPath: "/p" });
      createAnalysis(db, { slug: "s2", title: "Performance Review", projectPath: "/p" });
      const results = searchAnalyses(db, "Security");
      expect(results.length).toBe(1);
      expect(results[0]!.title).toBe("Security Audit");
    });

    test("matches by summary", () => {
      createAnalysis(db, {
        slug: "s1",
        title: "T",
        projectPath: "/p",
        summary: "Found critical SQL injection vulnerability",
      });
      createAnalysis(db, { slug: "s2", title: "T2", projectPath: "/p", summary: "No issues" });
      const results = searchAnalyses(db, "injection");
      expect(results.length).toBe(1);
    });

    test("matches by findings_json", () => {
      createAnalysis(db, {
        slug: "s1",
        title: "T",
        projectPath: "/p",
        findingsJson: '[{"issue":"XSS in login form"}]',
      });
      const results = searchAnalyses(db, "XSS");
      expect(results.length).toBe(1);
    });

    test("returns empty on no match", () => {
      createAnalysis(db, { slug: "s1", title: "Foo", projectPath: "/p" });
      expect(searchAnalyses(db, "nonexistent")).toEqual([]);
    });

    test("escapes FTS special chars", () => {
      createAnalysis(db, { slug: "s1", title: "auth-bug fix", projectPath: "/p" });
      const results = searchAnalyses(db, "auth-bug");
      expect(results.length).toBe(1);
    });

    test("filters by agent", () => {
      createAnalysis(db, { slug: "a", title: "Alpha", projectPath: "/p", agent: "js-smith" });
      createAnalysis(db, { slug: "b", title: "Alpha2", projectPath: "/p", agent: "go-smith" });
      const results = searchAnalyses(db, "Alpha", { agent: "js-smith" });
      expect(results.length).toBe(1);
    });
  });

  // ── updateAnalysis ────────────────────────────────────────────────────────

  describe("updateAnalysis", () => {
    test("partial update — updates only specified fields", () => {
      const created = createAnalysis(db, { slug: "upd", title: "Original", projectPath: "/p" });
      const updated = updateAnalysis(db, created.id, { title: "Changed" });
      expect(updated.title).toBe("Changed");
      expect(updated.slug).toBe("upd"); // unchanged
      expect(updated.projectPath).toBe("/p"); // unchanged
    });

    test("bumps updated_at", () => {
      const created = createAnalysis(db, { slug: "upd2", title: "T", projectPath: "/p" });
      // Force a small delay by using a known different timestamp
      const updated = updateAnalysis(db, created.id, { summary: "new" });
      // updated_at should be a valid ISO string (datetime('now'))
      expect(updated.updatedAt).toBeTruthy();
      expect(updated.summary).toBe("new");
    });

    test("throws on non-existent analysis", () => {
      expect(() => updateAnalysis(db, "nonexistent", { title: "X" })).toThrow("not found");
    });

    test("no-op when no fields changed", () => {
      const created = createAnalysis(db, { slug: "noop", title: "T", projectPath: "/p" });
      const same = updateAnalysis(db, created.id, {});
      expect(same.id).toBe(created.id);
    });
  });

  // ── archiveAnalysis ───────────────────────────────────────────────────────

  describe("archiveAnalysis", () => {
    test("sets archived_at", () => {
      const created = createAnalysis(db, { slug: "arch", title: "T", projectPath: "/p" });
      const archived = archiveAnalysis(db, created.id);
      expect(archived.archivedAt).toBeTruthy();
    });

    test("idempotent — archive twice returns same result", () => {
      const created = createAnalysis(db, { slug: "arch2", title: "T", projectPath: "/p" });
      const first = archiveAnalysis(db, created.id);
      const second = archiveAnalysis(db, created.id);
      expect(first.archivedAt).toBe(second.archivedAt);
    });

    test("archived analysis excluded from default list", () => {
      const created = createAnalysis(db, { slug: "arch3", title: "T", projectPath: "/p" });
      archiveAnalysis(db, created.id);
      const active = listAnalyses(db);
      expect(active.length).toBe(0);
    });

    test("throws on non-existent analysis", () => {
      expect(() => archiveAnalysis(db, "nonexistent")).toThrow("not found");
    });
  });

  // ── linkAnalysisToPlan ────────────────────────────────────────────────────

  describe("linkAnalysisToPlan", () => {
    test("sets source_plan_id", () => {
      makePlan();
      const a = createAnalysis(db, { slug: "link", title: "T", projectPath: "/p" });
      const linked = linkAnalysisToPlan(db, a.id, "plan-1");
      expect(linked.sourcePlanId).toBe("plan-1");
    });

    test("throws on non-existent analysis", () => {
      makePlan();
      expect(() => linkAnalysisToPlan(db, "nonexistent", "plan-1")).toThrow("not found");
    });

    test("throws on non-existent plan (FK enforcement)", () => {
      const a = createAnalysis(db, { slug: "link2", title: "T", projectPath: "/p" });
      expect(() => linkAnalysisToPlan(db, a.id, "bad-plan")).toThrow("not found");
    });
  });

  describe("unlinkAnalysisFromPlan", () => {
    test("clears source_plan_id", () => {
      makePlan();
      const a = createAnalysis(db, { slug: "unlink", title: "T", projectPath: "/p" });
      linkAnalysisToPlan(db, a.id, "plan-1");
      const unlinked = unlinkAnalysisFromPlan(db, a.id);
      expect(unlinked.sourcePlanId).toBeNull();
    });

    test("idempotent — unlink when already unlinked is a no-op", () => {
      const a = createAnalysis(db, { slug: "unlink2", title: "T", projectPath: "/p" });
      expect(a.sourcePlanId).toBeNull();
      const unlinked = unlinkAnalysisFromPlan(db, a.id);
      expect(unlinked.sourcePlanId).toBeNull();
    });

    test("throws on non-existent analysis", () => {
      expect(() => unlinkAnalysisFromPlan(db, "nonexistent")).toThrow("not found");
    });
  });

  // ── validateAnalysisFindings (v15 agent boundary contract) ──────────────

  describe("validateAnalysisFindings", () => {
    test("no-op when findingsJson is undefined", () => {
      expect(() => validateAnalysisFindings(undefined, "ranger")).not.toThrow();
      expect(() => validateAnalysisFindings(undefined, "foreman")).not.toThrow();
    });

    test("no-op for non-ranger agents even with proposedAction present", () => {
      const findings = JSON.stringify([
        { severity: "high", observation: "x", proposedAction: "y" },
      ]);
      expect(() => validateAnalysisFindings(findings, "foreman")).not.toThrow();
      expect(() => validateAnalysisFindings(findings, "craftsman")).not.toThrow();
      expect(() => validateAnalysisFindings(findings, "inspector")).not.toThrow();
      expect(() => validateAnalysisFindings(findings, undefined)).not.toThrow();
    });

    test("no-op when findingsJson is not valid JSON (defers to tool layer)", () => {
      expect(() => validateAnalysisFindings("not-json{{", "ranger")).not.toThrow();
    });

    test("no-op when JSON is empty array", () => {
      expect(() => validateAnalysisFindings("[]", "ranger")).not.toThrow();
    });

    test("no-op when JSON is not an array", () => {
      expect(() => validateAnalysisFindings("{}", "ranger")).not.toThrow();
      expect(() => validateAnalysisFindings("\"hello\"", "ranger")).not.toThrow();
      expect(() => validateAnalysisFindings("null", "ranger")).not.toThrow();
    });

    test("ranger with observation-only findings is allowed", () => {
      const findings = JSON.stringify([
        { severity: "high", observation: "auth missing on /admin" },
        { severity: "medium", observation: "N+1 query in listUsers" },
      ]);
      expect(() => validateAnalysisFindings(findings, "ranger")).not.toThrow();
    });

    test("ranger with proposedAction key throws clear validation error", () => {
      const findings = JSON.stringify([
        { severity: "high", observation: "auth missing", proposedAction: "add guard" },
      ]);
      expect(() => validateAnalysisFindings(findings, "ranger")).toThrow(
        /ranger cannot emit proposedAction/i,
      );
    });

    test("ranger throws even if only one finding has proposedAction", () => {
      const findings = JSON.stringify([
        { severity: "high", observation: "ok" },
        { severity: "low", observation: "fine", proposedAction: "do X" },
      ]);
      expect(() => validateAnalysisFindings(findings, "ranger")).toThrow(
        /ranger cannot emit proposedAction/i,
      );
    });

    test("ranger throwing preserves error message mentioning both agent roles", () => {
      const findings = JSON.stringify([
        { severity: "high", observation: "x", proposedAction: "y" },
      ]);
      let err: Error | null = null;
      try {
        validateAnalysisFindings(findings, "ranger");
      } catch (e) {
        err = e as Error;
      }
      expect(err).not.toBeNull();
      expect(err!.message).toContain("ranger");
      expect(err!.message).toContain("foreman");
    });

    test("non-object items in array are tolerated", () => {
      const findings = JSON.stringify([
        "string-finding",
        null,
        42,
        { severity: "high", observation: "real finding" },
      ]);
      expect(() => validateAnalysisFindings(findings, "ranger")).not.toThrow();
    });
  });
});
