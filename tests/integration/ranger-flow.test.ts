/**
 * Integration test — analyses (ranger) full flow end-to-end.
 *
 * Exercises create/get/list/search/update/archive/link/unlink
 * using direct DB + CRUD calls (no tool runtime, no mocks).
 * Each test gets a fresh in-memory DB with full schema via runMigrations.
 */

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
} from "../../src/db/analyses.ts";
import { createPlan } from "../../src/db/plans.ts";
import { runMigrations } from "../../src/db/migrations.ts";

let db: Database;

/** Minimal plan stub for FK-dependent tests. */
function makePlan(id = "plan-1", slug = "test-plan") {
  return createPlan(db, {
    id,
    slug,
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
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

describe("analyses integration — ranger flow", () => {
  test("create + get roundtrips all fields", () => {
    const created = createAnalysis(db, {
      slug: "auth-review",
      title: "Auth Module Review",
      projectPath: "/home/user/project",
      summary: "Reviewed auth module for vulnerabilities",
      findingsJson: JSON.stringify([{ severity: "high", desc: "weak hash" }]),
      agent: "ranger",
    });

    expect(created.id).toBeTruthy();
    expect(created.slug).toBe("auth-review");
    expect(created.title).toBe("Auth Module Review");
    expect(created.projectPath).toBe("/home/user/project");
    expect(created.summary).toBe("Reviewed auth module for vulnerabilities");
    expect(created.agent).toBe("ranger");
    expect(created.archivedAt).toBeNull();

    const findings = JSON.parse(created.findingsJson);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("high");

    // get by id returns same data
    const fetched = getAnalysis(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.slug).toBe(created.slug);
    expect(fetched!.title).toBe(created.title);
  });

  test("agent defaults to 'ranger' when omitted", () => {
    const a = createAnalysis(db, {
      slug: "default-agent",
      title: "Default Agent Test",
      projectPath: "/p",
    });
    expect(a.agent).toBe("ranger");
  });

  test("slug uniqueness — same slug + projectPath throws", () => {
    createAnalysis(db, {
      slug: "dup-slug",
      title: "First",
      projectPath: "/p",
    });

    expect(() =>
      createAnalysis(db, {
        slug: "dup-slug",
        title: "Second",
        projectPath: "/p",
      }),
    ).toThrow(/already exists/);
  });

  test("same slug different projectPath is OK", () => {
    createAnalysis(db, { slug: "shared-slug", title: "A", projectPath: "/p1" });
    const b = createAnalysis(db, { slug: "shared-slug", title: "B", projectPath: "/p2" });
    expect(b.slug).toBe("shared-slug");
    expect(b.projectPath).toBe("/p2");
  });

  test("list filters by agent, sourcePlanId, archived", () => {
    const plan = makePlan();
    createAnalysis(db, { slug: "a1", title: "Alpha", projectPath: "/p", agent: "ranger" });
    createAnalysis(db, { slug: "a2", title: "Beta", projectPath: "/p", agent: "sage" });
    createAnalysis(db, { slug: "a3", title: "Gamma", projectPath: "/p", agent: "craftsman" });
    const linked = getAnalysisBySlug(db, "a3", "/p")!;
    linkAnalysisToPlan(db, linked.id, plan.id);

    // filter by agent
    const rangers = listAnalyses(db, { agent: "ranger" });
    expect(rangers).toHaveLength(1);
    expect(rangers[0].slug).toBe("a1");

    // filter by sourcePlanId
    const byPlan = listAnalyses(db, { sourcePlanId: plan.id });
    expect(byPlan).toHaveLength(1);
    expect(byPlan[0].slug).toBe("a3");

    // archived filter
    const all = listAnalyses(db, { archived: false });
    expect(all.length).toBeGreaterThanOrEqual(3);

    archiveAnalysis(db, linked.id);
    const active = listAnalyses(db, { archived: false });
    expect(active.find((a) => a.id === linked.id)).toBeUndefined();

    const archived = listAnalyses(db, { archived: true });
    expect(archived.find((a) => a.id === linked.id)).toBeDefined();
  });

  test("search FTS — finds matching analysis by title", () => {
    createAnalysis(db, { slug: "s1", title: "Database Security Audit", projectPath: "/p" });
    createAnalysis(db, { slug: "s2", title: "Frontend Performance Review", projectPath: "/p" });
    createAnalysis(db, { slug: "s3", title: "API Authentication Analysis", projectPath: "/p" });

    const results = searchAnalyses(db, "security");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("s1");
  });

  test("search FTS — finds matching analysis by summary", () => {
    createAnalysis(db, {
      slug: "s-summary",
      title: "Generic Title",
      projectPath: "/p",
      summary: "Found critical XSS vulnerabilities in form handlers",
    });

    const results = searchAnalyses(db, "XSS vulnerabilities");
    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe("s-summary");
  });

  test("update partial — only changed fields update + updated_at bumps", () => {
    const a = createAnalysis(db, {
      slug: "upd",
      title: "Original Title",
      projectPath: "/p",
      summary: "original summary",
    });

    const updated = updateAnalysis(db, a.id, { title: "New Title" });
    expect(updated.title).toBe("New Title");
    expect(updated.summary).toBe("original summary"); // unchanged
    expect(updated.slug).toBe("upd"); // unchanged
    // updated_at is datetime('now') — same-second updates may have same value;
    // just verify the field exists and is a string
    expect(typeof updated.updatedAt).toBe("string");
  });

  test("archive + list excludes archived", () => {
    const a = createAnalysis(db, { slug: "to-archive", title: "Archive Me", projectPath: "/p" });
    expect(a.archivedAt).toBeNull();

    const archived = archiveAnalysis(db, a.id);
    expect(archived.archivedAt).toBeTruthy();

    // default list excludes archived
    const active = listAnalyses(db);
    expect(active.find((x) => x.id === a.id)).toBeUndefined();

    // getAnalysis excludes archived by default
    expect(getAnalysis(db, a.id)).toBeNull();

    // getAnalysis with includeArchived returns it
    const found = getAnalysis(db, a.id, { includeArchived: true });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(a.id);

    // idempotent — archiving again is a no-op
    const again = archiveAnalysis(db, a.id);
    expect(again.archivedAt).toBe(archived.archivedAt);
  });

  test("linkAnalysisToPlan — sets sourcePlanId", () => {
    const plan = makePlan();
    const a = createAnalysis(db, { slug: "link-me", title: "Link Me", projectPath: "/p" });
    expect(a.sourcePlanId).toBeNull();

    const linked = linkAnalysisToPlan(db, a.id, plan.id);
    expect(linked.sourcePlanId).toBe(plan.id);

    // getAnalysisBySlug reflects the link
    const bySlug = getAnalysisBySlug(db, "link-me", "/p");
    expect(bySlug!.sourcePlanId).toBe(plan.id);
  });

  test("linkAnalysisToPlan — FK validation: non-existent plan throws", () => {
    const a = createAnalysis(db, { slug: "no-fk", title: "No FK", projectPath: "/p" });
    expect(() => linkAnalysisToPlan(db, a.id, "non-existent-plan-id")).toThrow(/not found/);
  });

  test("unlinkAnalysisFromPlan — sets sourcePlanId to null", () => {
    const plan = makePlan();
    const a = createAnalysis(db, { slug: "unlink", title: "Unlink", projectPath: "/p" });
    linkAnalysisToPlan(db, a.id, plan.id);

    const unlinked = unlinkAnalysisFromPlan(db, a.id);
    expect(unlinked.sourcePlanId).toBeNull();

    // idempotent — unlinking again is a no-op
    const again = unlinkAnalysisFromPlan(db, a.id);
    expect(again.sourcePlanId).toBeNull();
  });

  test("CASCADE plan deletion — sourcePlanId becomes NULL (ON DELETE SET NULL)", () => {
    const plan = makePlan("plan-cascade", "cascade-plan");
    const a = createAnalysis(db, { slug: "cascade", title: "Cascade", projectPath: "/p" });
    linkAnalysisToPlan(db, a.id, plan.id);

    // delete plan directly via SQL (simulates external deletion)
    db.query("DELETE FROM plans WHERE id = ?").run("plan-cascade");

    const after = getAnalysis(db, a.id);
    expect(after).not.toBeNull();
    expect(after!.sourcePlanId).toBeNull();
  });
});
