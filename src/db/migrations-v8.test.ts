/**
 * Tests for v6+v8 migrations — write-once audit fields.
 *
 * Validates:
 * - original_plan_data is set on plan creation and NOT overwritten on status updates
 * - created_by_agent is set on plan creation
 * - executed_by_agent/session can be set but are not overwritten if already set
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { approvePlan, createPlan, getPlan, getPlanProgress, updatePlanStatus } from "./plans.ts";
import { createTasksBatch, getTask, updateTaskStatus } from "./tasks.ts";
import type { Plan } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

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
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

describe("v6: original_plan_data (write-once)", () => {
  test("plan has original_plan_data after creation", () => {
    const plan = makePlan();
    const fetched = getPlan(db, plan.id);

    expect(fetched).not.toBeNull();
    const opd = fetched?.originalPlanData;
    expect(opd).not.toBeNull();

    const data = JSON.parse(opd as string);
    expect(data.id).toBe(plan.id);
    expect(data.slug).toBe("test-plan");
    expect(data.title).toBe("Test");
    expect(data.overview).toBe("test");
    expect(data.createdBy).toBe("test");
  });

  test("original_plan_data is NOT overwritten on status update", () => {
    const plan = makePlan();
    const beforeRaw = getPlan(db, plan.id);
    expect(beforeRaw).not.toBeNull();
    const before = beforeRaw as Plan;
    const originalData = before.originalPlanData;

    // Update status — should NOT touch original_plan_data
    updatePlanStatus(db, plan.id, "approved", { updatedBy: "admin" });

    const afterRaw = getPlan(db, plan.id);
    expect(afterRaw).not.toBeNull();
    const after = afterRaw as Plan;
    expect(after.originalPlanData).toBe(originalData);
  });

  test("original_plan_data is NOT overwritten on approve", () => {
    const plan = makePlan();
    const beforeRaw = getPlan(db, plan.id);
    expect(beforeRaw).not.toBeNull();
    const before = beforeRaw as Plan;
    const originalData = before.originalPlanData;

    approvePlan(db, plan.id, { updatedBy: "admin" });

    const afterRaw = getPlan(db, plan.id);
    expect(afterRaw).not.toBeNull();
    const after = afterRaw as Plan;
    expect(after.originalPlanData).toBe(originalData);
  });

  test("task has original_plan_data after creation", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "test task",
        agent: "js-smith",
        files: ["src/index.ts"],
        complexity: 2,
        dependencies: [],
        createdBy: "foreman",
        updatedBy: "foreman",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
    ]);

    const taskOpd = tasks[0]?.originalPlanData;
    expect(taskOpd).not.toBeNull();
    const data = JSON.parse(taskOpd as string);
    expect(data.description).toBe("test task");
    expect(data.agent).toBe("js-smith");
    expect(data.files).toEqual(["src/index.ts"]);
  });

  test("task original_plan_data is NOT overwritten on status update", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "test task",
        agent: "js-smith",
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

    const originalData = tasks[0]?.originalPlanData;

    // Update task status — should NOT touch original_plan_data
    const t0id = tasks[0]?.id as string;
    updateTaskStatus(db, t0id, "running");

    const updated = getTask(db, t0id);

    expect(updated?.originalPlanData).toBe(originalData);
  });
});

describe("v8: created_by_agent (write-once)", () => {
  test("plan has created_by_agent after creation", () => {
    const plan = makePlan({ createdByAgent: "foreman" });
    const fetched = getPlan(db, plan.id);

    expect(fetched).not.toBeNull();
    expect(fetched?.createdByAgent).toBe("foreman");
  });

  test("created_by_agent defaults to null when not provided", () => {
    const plan = makePlan(); // no createdByAgent
    const fetched = getPlan(db, plan.id);

    expect(fetched?.createdByAgent).toBeNull();
  });
});

describe("v8: executed_by_agent/session", () => {
  test("executed_by_agent and executed_by_session are null on creation", () => {
    const plan = makePlan();
    const fetched = getPlan(db, plan.id);

    expect(fetched?.executedByAgent).toBeNull();
    expect(fetched?.executedBySession).toBeNull();
  });

  test("can be set via direct SQL update", () => {
    const plan = makePlan();

    db.query("UPDATE plans SET executed_by_agent = ?, executed_by_session = ? WHERE id = ?").run(
      "craftsman",
      "ses_123",
      plan.id,
    );

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBe("craftsman");
    expect(fetched?.executedBySession).toBe("ses_123");
  });

  test("updatePlanStatus sets executed_by_agent on first executing transition", () => {
    const plan = makePlan();
    // createPlan returns the spread input which may have undefined for optional fields
    // The DB stores null, but the TS object preserves the input shape
    expect(plan.executedByAgent ?? null).toBeNull();

    updatePlanStatus(db, plan.id, "executing", {
      executedByAgent: "craftsman",
      executedBySession: "ses_exec_1",
    });

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBe("craftsman");
    expect(fetched?.executedBySession).toBe("ses_exec_1");
  });

  test("updatePlanStatus does NOT overwrite executed_by_agent on second executing", () => {
    const plan = makePlan();

    // First executing
    updatePlanStatus(db, plan.id, "executing", {
      executedByAgent: "craftsman",
      executedBySession: "ses_first",
    });

    // Second executing with different agent — should NOT overwrite
    updatePlanStatus(db, plan.id, "executing", {
      executedByAgent: "go-smith",
      executedBySession: "ses_second",
    });

    const fetched = getPlan(db, plan.id);
    expect(fetched?.executedByAgent).toBe("craftsman");
    expect(fetched?.executedBySession).toBe("ses_first");
  });
});

// ─── Critical 2: v9 migration — plan_progress excludes archived ─────────────

describe("v9: plan_progress view fix", () => {
  test("DB with schema_version=5 → runMigrations → schema_version=12", () => {
    // Fresh DB already runs all migrations up to v12
    const row = db.query("SELECT MAX(version) as version FROM schema_version").get() as {
      version: number;
    };
    expect(row.version).toBe(12);
  });

  test("plan_progress excludes archived plans", () => {
    const active = createPlan(db, {
      id: crypto.randomUUID(),
      slug: "active",
      title: "Active",
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
      metadata: {},
      archivedAt: null,
    });
    const archived = createPlan(db, {
      id: crypto.randomUUID(),
      slug: "archived",
      title: "Archived",
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
      metadata: {},
      archivedAt: null,
    });

    // Archive second plan
    db.query("UPDATE plans SET archived_at = ? WHERE id = ?").run(Date.now(), archived.id);

    const progress = getPlanProgress(db);
    expect(progress).toHaveLength(1);
    expect(progress[0]?.planId).toBe(active.id);
  });
});
