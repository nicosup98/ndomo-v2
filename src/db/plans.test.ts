/**
 * Tests for plan status transitions and FK-scoped ensureSession.
 *
 * Validates Fix #1 (scoped ensureSession) and Fix #8 (auto-link session):
 * - Terminal statuses (completed/failed/abandoned) do NOT auto-create sessions
 * - Active statuses (executing/approved) DO auto-create sessions
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpec } from "../spec/index.ts";
import { runMigrations } from "./migrations.ts";
import {
  approvePlan,
  createPlan,
  deletePlan,
  getPlan,
  getPlanBySlug,
  getPlanProgress,
  listPlans,
  updatePlanStatus,
} from "./plans.ts";
import { getSession } from "./sessions.ts";
import { createTasksBatch } from "./tasks.ts";
import type { Plan } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

/**
 * Helper — create a plan with sensible defaults, override only what the test needs.
 */
function makePlan(overrides: Partial<Parameters<typeof createPlan>[1]> = {}): Plan {
  return createPlan(db, {
    id: crypto.randomUUID(),
    slug: "test-plan",
    title: "Test",
    status: "draft",
    priority: 2,
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    overview: "test",
    approach: null,
    complexity: 3,
    createdBy: "test",
    updatedBy: "test",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    owner: "foreman",
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

describe("updatePlanStatus", () => {
  test("status=completed succeeds without sessionId", () => {
    const plan = makePlan();
    const updated = updatePlanStatus(db, plan.id, "completed");

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("completed");
  });

  test("status=completed + sessionId does NOT auto-create session (scope fix)", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    updatePlanStatus(db, plan.id, "completed", { sessionId });

    // Terminal status — no session row should be created
    const session = getSession(db, sessionId);
    expect(session).toBeNull();
  });

  test("status=executing + sessionId auto-creates session", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    updatePlanStatus(db, plan.id, "executing", { sessionId });

    const session = getSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);
  });

  test("status=approved + sessionId auto-creates session", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    updatePlanStatus(db, plan.id, "approved", { sessionId });

    const session = getSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);
  });

  test("status=failed + sessionId does NOT auto-create session (scope fix)", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    updatePlanStatus(db, plan.id, "failed", { sessionId });

    // Terminal status — no session row should be created
    const session = getSession(db, sessionId);
    expect(session).toBeNull();
  });

  test("status=abandoned + sessionId does NOT auto-create session (scope fix)", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    updatePlanStatus(db, plan.id, "abandoned", { sessionId });

    // Terminal status — no session row should be created
    const session = getSession(db, sessionId);
    expect(session).toBeNull();
  });
});

describe("approvePlan", () => {
  test("auto-creates session when sessionId provided and missing", () => {
    const plan = makePlan();
    const sessionId = `ses_${crypto.randomUUID()}`;

    const approved = approvePlan(db, plan.id, { sessionId });

    expect(approved).not.toBeNull();
    expect(approved?.status).toBe("approved");
    expect(approved?.sessionId).toBe(sessionId);

    const session = getSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);
  });

  test("succeeds without sessionId and does NOT create session", () => {
    const plan = makePlan();

    const approved = approvePlan(db, plan.id, { updatedBy: "test" });

    expect(approved).not.toBeNull();
    expect(approved?.status).toBe("approved");
    expect(approved?.sessionId).toBeNull();

    // No session row should exist — no sessionId was provided
    const rows = db.query("SELECT * FROM sessions").all();
    expect(rows).toHaveLength(0);
  });
});

// ─── REQ-004: gate T0 — spec lint before approval ─────────────────────────────

describe("approvePlan — T0 spec gate (REQ-004)", () => {
  /** Fresh tmpdir project root — createSpec writes <dir>/.ndomo/specs/<NNN-slug>/spec.md. */
  function makeTmpProject(): string {
    return mkdtempSync(join(tmpdir(), "ndomo-plan-t0-"));
  }

  test("AC-004-1: error-severity finding blocks approval; status and approved_at untouched", () => {
    const projectDir = makeTmpProject();
    try {
      const spec = createSpec(projectDir, { slug: "gate-t0", title: "Gate T0" });
      // Inject an L2 error: duplicate a canonical section heading.
      const raw = readFileSync(spec.path, "utf8");
      writeFileSync(spec.path, `${raw}\n## 5. Requirements\n\nduplicate section injected\n`);

      const plan = makePlan({ metadata: { specId: spec.id } });

      let caught: Error | null = null;
      try {
        approvePlan(db, plan.id, { updatedBy: "test", projectDir });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught?.message).toContain("ndomo:");
      expect(caught?.message).toContain(spec.id);
      expect(caught?.message).toContain(spec.path);
      expect(caught?.message).toContain("L2");

      // Blocked BEFORE any write: previous status, approved_at still null.
      const after = getPlan(db, plan.id);
      expect(after?.status).toBe("draft");
      expect(after?.approvedAt).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("AC-004-2: clean spec → approve succeeds with status approved and approved_at set", () => {
    const projectDir = makeTmpProject();
    try {
      const spec = createSpec(projectDir, { slug: "clean-spec", title: "Clean Spec" });
      const plan = makePlan({ metadata: { specId: spec.id } });

      const approved = approvePlan(db, plan.id, { updatedBy: "test", projectDir });

      expect(approved).not.toBeNull();
      expect(approved?.status).toBe("approved");
      expect(approved?.approvedAt).toBeTypeOf("number");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("warning-only findings (L8: matrix row with empty tests cell) do NOT block approval", () => {
    const projectDir = makeTmpProject();
    try {
      const spec = createSpec(projectDir, { slug: "warn-spec", title: "Warn Spec" });
      // Inject ONE live (non-fenced) matrix row with an empty tests cell into
      // section 11 → the linter reports it as an L8 warning, never an error.
      const raw = readFileSync(spec.path, "utf8");
      const anchor = "## 12.";
      const idx = raw.indexOf(anchor);
      expect(idx).toBeGreaterThan(-1);
      const liveMatrix = [
        "| REQ | AC | Tasks | Tests | state |",
        "|---|---|---|---|---|",
        "| REQ-001 | AC-001-1 | task-x |  | red |",
        "",
        "",
      ].join("\n");
      writeFileSync(spec.path, `${raw.slice(0, idx)}${liveMatrix}${raw.slice(idx)}`);

      const plan = makePlan({ metadata: { specId: spec.id } });
      const approved = approvePlan(db, plan.id, { updatedBy: "test", projectDir });

      expect(approved?.status).toBe("approved");
      expect(approved?.approvedAt).toBeTypeOf("number");
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("REQ-006: plan WITHOUT metadata.specId approves with zero new behavior (no fs access)", () => {
    const plan = makePlan({ metadata: { category: "feature" } });

    // No projectDir, no specId → falls back to resolveProjectDir({}) and must
    // behave exactly like the pre-gate implementation.
    const approved = approvePlan(db, plan.id, { updatedBy: "test" });

    expect(approved).not.toBeNull();
    expect(approved?.status).toBe("approved");
    expect(approved?.approvedAt).toBeTypeOf("number");
    expect(approved?.sessionId).toBeNull();
  });

  test("edge (§9): specId pointing at a missing file blocks; message names the missing path", () => {
    const projectDir = makeTmpProject();
    try {
      const plan = makePlan({ metadata: { specId: "missing/no-such-spec.md" } });

      let caught: Error | null = null;
      try {
        approvePlan(db, plan.id, { updatedBy: "test", projectDir });
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).not.toBeNull();
      expect(caught?.message).toContain("ndomo:");
      // The L0 finding itself names the missing path.
      expect(caught?.message).toContain("no-such-spec.md");

      const after = getPlan(db, plan.id);
      expect(after?.status).toBe("draft");
      expect(after?.approvedAt).toBeNull();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("deletePlan", () => {
  test("success: deletes approved plan with all done tasks", () => {
    const plan = makePlan({ status: "approved" });
    // Create tasks — all done
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task1",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);
    // Mark task as done
    db.query("UPDATE plan_tasks SET status = 'done' WHERE id = ?").run(tasks[0]?.id as string);

    const result = deletePlan(db, plan.id, { confirm: true });

    expect(result.planId).toBe(plan.id);
    expect(result.slug).toBe("test-plan");
    expect(result.tasksDeleted).toBe(1);
    expect(result.sessionsUnlinked).toBe(0);

    // Verify plan is gone
    expect(getPlan(db, plan.id)).toBeNull();
    // Verify tasks are gone (CASCADE)
    const taskRows = db.query("SELECT * FROM plan_tasks WHERE plan_id = ?").all(plan.id);
    expect(taskRows).toHaveLength(0);
  });

  test("rejects draft plan", () => {
    const plan = makePlan({ status: "draft" });

    expect(() => deletePlan(db, plan.id, { confirm: true })).toThrow("cannot delete a draft plan");
  });

  test("rejects plan with pending/running tasks", () => {
    const plan = makePlan({ status: "approved" });
    createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "active-task",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);

    expect(() => deletePlan(db, plan.id, { confirm: true })).toThrow("active task(s)");
  });

  test("rejects without confirm: true", () => {
    const plan = makePlan({ status: "approved" });

    expect(() => deletePlan(db, plan.id, { confirm: false })).toThrow("confirm: true");
  });
});

describe("createPlan", () => {
  test("sessionId=null succeeds", () => {
    const plan = makePlan({ sessionId: null });

    expect(plan).not.toBeNull();
    expect(plan.sessionId).toBeNull();

    const fetched = getPlan(db, plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.sessionId).toBeNull();
  });
});

// ─── Critical 1: updatePlanStatus executed_by via wrapper-style call ─────────

describe("updatePlanStatus — executed_by on 'executing' (wrapper-style)", () => {
  test("executing → sets executed_by_agent from opts", () => {
    const plan = makePlan();
    updatePlanStatus(db, plan.id, "executing", {
      updatedBy: "js-smith",
      sessionId: "ses_exec_1",
      executedByAgent: "js-smith",
      executedBySession: "ses_exec_1",
    });

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBe("js-smith");
    expect(fetched?.executedBySession).toBe("ses_exec_1");
  });

  test("executing → completed → executed_by_agent does NOT change (write-once)", () => {
    const plan = makePlan();
    updatePlanStatus(db, plan.id, "executing", {
      updatedBy: "js-smith",
      sessionId: "ses_exec_1",
      executedByAgent: "js-smith",
      executedBySession: "ses_exec_1",
    });
    updatePlanStatus(db, plan.id, "completed", { updatedBy: "js-smith" });

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBe("js-smith");
    expect(fetched?.executedBySession).toBe("ses_exec_1");
  });

  test("approved → does NOT set executed_by_agent", () => {
    const plan = makePlan();
    updatePlanStatus(db, plan.id, "approved", {
      updatedBy: "js-smith",
      sessionId: "ses_appr",
    });

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBeNull();
    expect(fetched?.executedBySession).toBeNull();
  });
});

describe("plan_progress view", () => {
  test("excludes archived plans from progress", () => {
    // Create two plans
    const active = makePlan({ slug: "active-plan", title: "Active" });
    const archived = makePlan({ slug: "archived-plan", title: "Archived" });

    // Add tasks to both
    createTasksBatch(db, active.id, [
      {
        orderIndex: 0,
        description: "task1",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);
    createTasksBatch(db, archived.id, [
      {
        orderIndex: 0,
        description: "task2",
        agent: "test",
        files: [],
        complexity: 1,
        dependencies: [],
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);

    // Archive the second plan
    db.query("UPDATE plans SET archived_at = ? WHERE id = ?").run(Date.now(), archived.id);
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE plan_id = ?").run(
      Date.now(),
      archived.id,
    );

    const progress = getPlanProgress(db);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.planId).toBe(active.id);
    expect(progress[0]?.slug).toBe("active-plan");
  });
});

// ─── Issue 2: plan_files JOIN ──────────────────────────────────────────────

describe("getPlan — plan_files JOIN", () => {
  test("returns files array when plan has files", () => {
    const plan = makePlan();

    // Insert files
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/index.ts",
      "input",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "README.md",
      "reference",
    );

    const fetched = getPlan(db, plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.files).toHaveLength(2);
    expect(fetched?.files?.[0]).toEqual({ filePath: "README.md", role: "reference" });
    expect(fetched?.files?.[1]).toEqual({ filePath: "src/index.ts", role: "input" });
  });

  test("returns empty files array when plan has no files", () => {
    const plan = makePlan();
    const fetched = getPlan(db, plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.files).toEqual([]);
  });
});

describe("getPlanBySlug — plan_files JOIN", () => {
  test("returns files array when plan has files", () => {
    const plan = makePlan({ slug: "slug-test" });

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/utils.ts",
      "modified",
    );

    const fetched = getPlanBySlug(db, "slug-test");
    expect(fetched).not.toBeNull();
    expect(fetched?.files).toHaveLength(1);
    expect(fetched?.files?.[0]).toEqual({ filePath: "src/utils.ts", role: "modified" });
  });

  test("returns empty files array when plan has no files", () => {
    makePlan({ slug: "no-files" });
    const fetched = getPlanBySlug(db, "no-files");
    expect(fetched).not.toBeNull();
    expect(fetched?.files).toEqual([]);
  });
});

describe("listPlans — plan_files JOIN", () => {
  test("returns files for each plan", () => {
    const plan1 = makePlan({ slug: "plan-1" });
    const plan2 = makePlan({ slug: "plan-2" });

    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan1.id,
      "src/a.ts",
      "input",
    );
    db.query("INSERT INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan2.id,
      "src/b.ts",
      "output",
    );

    const plans = listPlans(db);
    expect(plans).toHaveLength(2);

    const p1 = plans.find((p) => p.id === plan1.id);
    const p2 = plans.find((p) => p.id === plan2.id);

    expect(p1?.files).toHaveLength(1);
    expect(p1?.files?.[0]).toEqual({ filePath: "src/a.ts", role: "input" });
    expect(p2?.files).toHaveLength(1);
    expect(p2?.files?.[0]).toEqual({ filePath: "src/b.ts", role: "output" });
  });

  test("returns empty files for plans without files", () => {
    makePlan({ slug: "empty-1" });
    makePlan({ slug: "empty-2" });

    const plans = listPlans(db);
    expect(plans).toHaveLength(2);
    expect(plans[0]?.files).toEqual([]);
    expect(plans[1]?.files).toEqual([]);
  });
});

// ─── M5: original_plan_data snapshot completeness ───────────────────────────

describe("createPlan — original_plan_data snapshot (M5)", () => {
  test("snapshot includes files array", () => {
    const plan = makePlan({ files: [{ filePath: "src/index.ts", role: "input" }] });
    const snapshot = JSON.parse(plan.originalPlanData ?? "{}");

    expect(snapshot.files).toEqual([{ filePath: "src/index.ts", role: "input" }]);
  });

  test("snapshot includes metadata object", () => {
    const plan = makePlan({
      metadata: { category: "feature", externalRefs: { jiraTicket: "ND-42" } },
    });
    const snapshot = JSON.parse(plan.originalPlanData ?? "{}");

    expect(snapshot.metadata).toEqual({
      category: "feature",
      externalRefs: { jiraTicket: "ND-42" },
    });
  });

  test("snapshot includes approach, priority, complexity", () => {
    const plan = makePlan({ approach: "top-down", priority: 1, complexity: 5 });
    const snapshot = JSON.parse(plan.originalPlanData ?? "{}");

    expect(snapshot.approach).toBe("top-down");
    expect(snapshot.priority).toBe(1);
    expect(snapshot.complexity).toBe(5);
  });

  test("snapshot includes empty arrays/objects when fields omitted", () => {
    const plan = makePlan();
    const snapshot = JSON.parse(plan.originalPlanData ?? "{}");

    expect(snapshot.files).toEqual([]);
    expect(snapshot.metadata).toEqual({});
  });
});
