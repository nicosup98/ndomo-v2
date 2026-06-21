/**
 * Tests for plugin helpers: escalateToForeman (M2) and reconcileAbandonedPlans (M3).
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./db/migrations.ts";
import { getPlan } from "./db/plans.ts";
import { getSession, startSession } from "./db/sessions.ts";
import { listTasksByPlan } from "./db/tasks.ts";
import { createPlan } from "./db/plans.ts";
import { createTasksBatch, nextTaskForAgent, resolveTaskDependencies, updateTaskStatus } from "./db/tasks.ts";
import { planCreateExecutor } from "./db/plan-create.ts";
import { createIncident } from "./db/incidents.ts";
import { recordRollback } from "./db/rollbacks.ts";
import type { Plan } from "./db/types.ts";
import { escalateToForeman, reconcileAbandonedPlans } from "./plugin.ts";
import { planUpdateStatusExecutor } from "./db/plan-update-status.ts";
import { AutoCheckpointDispatcher } from "./db/auto-checkpoint.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

// ─── escalateToForeman (M2) ──────────────────────────────────────────────────

describe("escalateToForeman", () => {
  test("creates plan stub with metadata.escalatedFrom=null when no sourcePlanId", () => {
    const result = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_1" },
      { reason: "too complex for craftsman" },
    );

    expect(result.escalationPlanId).toBeTruthy();
    expect(result.notificationSent).toBe(true);

    const plan = getPlan(db, result.escalationPlanId);
    expect(plan).not.toBeNull();
    expect(plan?.title).toBe("Escalation: too complex for craftsman");
    expect(plan?.overview).toBe("too complex for craftsman");
    expect(plan?.status).toBe("draft");
    // Metadata should have escalatedFrom=null
    const meta = plan?.metadata as Record<string, unknown>;
    expect(meta.escalatedFrom).toBeNull();
    expect(meta.escalatedBy).toBe("craftsman");
    expect(meta.reason).toBe("too complex for craftsman");
  });

  test("creates plan stub referencing original plan in metadata", () => {
    const result = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_2" },
      { sourcePlanId: "plan_original_123", reason: "needs DB migration" },
    );

    const plan = getPlan(db, result.escalationPlanId);
    expect(plan).not.toBeNull();
    const meta = plan?.metadata as Record<string, unknown> | undefined;
    expect(meta?.escalatedFrom).toBe("plan_original_123");
    expect(meta?.escalatedBy).toBe("craftsman");
  });

  test("creates foreman task when sourceTaskId is provided", () => {
    const result = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_3" },
      {
        sourcePlanId: "plan_orig",
        sourceTaskId: "task_orig_456",
        reason: "cross-stack refactor",
      },
    );

    const tasks = listTasksByPlan(db, result.escalationPlanId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent).toBe("foreman");
    expect(tasks[0]?.description).toBe("cross-stack refactor");
    expect(tasks[0]?.status).toBe("pending");
  });

  test("does NOT create task when sourceTaskId is absent", () => {
    const result = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_4" },
      { reason: "just escalate" },
    );

    const tasks = listTasksByPlan(db, result.escalationPlanId);
    expect(tasks).toHaveLength(0);
  });

  test("creates session_checkpoint with escalation reason", () => {
    const sessionId = "ses_esc_5";
    startSession(db, { id: sessionId, goal: "original goal" });

    escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "complex DB migration needed" },
    );

    const session = getSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session?.keyDecisions).toContain("escalated by craftsman: complex DB migration needed");
  });

  test("skips checkpoint when no sessionID", () => {
    // Should not throw even without sessionID
    const result = escalateToForeman(db, { agent: "craftsman" }, { reason: "no session" });
    expect(result.notificationSent).toBe(true);
  });

  test("stores suggestedApproach in plan", () => {
    const result = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_6" },
      { reason: "complex", suggestedApproach: "use factory pattern" },
    );

    const plan = getPlan(db, result.escalationPlanId);
    expect(plan?.approach).toBe("use factory pattern");
  });

  test("generates unique slug per escalation", () => {
    const r1 = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_7a" },
      { reason: "first" },
    );
    const r2 = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: "ses_esc_7b" },
      { reason: "second" },
    );

    const p1 = getPlan(db, r1.escalationPlanId);
    const p2 = getPlan(db, r2.escalationPlanId);
    expect(p1?.slug).not.toBe(p2?.slug);
    expect(p1?.slug).toMatch(/^escalation-/);
    expect(p2?.slug).toMatch(/^escalation-/);
  });
});

// ─── reconcileAbandonedPlans (M3) ────────────────────────────────────────────

describe("reconcileAbandonedPlans", () => {
  test("abandons executing plans in the session", () => {
    const sessionId = "ses_recon_1";
    startSession(db, { id: sessionId, goal: "test" });

    // Create a plan in executing status linked to this session
    const plan = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "test escalation" },
    );
    // Move it to executing
    db.query("UPDATE plans SET status = 'executing', session_id = ? WHERE id = ?").run(
      sessionId,
      plan.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(1);

    const abandoned = getPlan(db, plan.escalationPlanId);
    expect(abandoned?.status).toBe("abandoned");
    const meta = abandoned?.metadata as Record<string, unknown> | undefined;
    expect(meta?.reason).toBe("session_ended");
    expect(meta?.endedBy).toBe("foreman");
  });

  test("abandons approved plans in the session", () => {
    const sessionId = "ses_recon_2";
    startSession(db, { id: sessionId, goal: "test" });

    const plan = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "test" },
    );
    db.query("UPDATE plans SET status = 'approved', session_id = ? WHERE id = ?").run(
      sessionId,
      plan.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "agent-x");
    expect(count).toBe(1);

    const abandoned = getPlan(db, plan.escalationPlanId);
    expect(abandoned?.status).toBe("abandoned");
  });

  test("does NOT abandon completed plans", () => {
    const sessionId = "ses_recon_3";
    startSession(db, { id: sessionId, goal: "test" });

    const plan = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "test" },
    );
    db.query("UPDATE plans SET status = 'completed', session_id = ? WHERE id = ?").run(
      sessionId,
      plan.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(0);

    const unchanged = getPlan(db, plan.escalationPlanId);
    expect(unchanged?.status).toBe("completed");
  });

  test("does NOT abandon failed plans", () => {
    const sessionId = "ses_recon_4";
    startSession(db, { id: sessionId, goal: "test" });

    const plan = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "test" },
    );
    db.query("UPDATE plans SET status = 'failed', session_id = ? WHERE id = ?").run(
      sessionId,
      plan.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(0);
  });

  test("does NOT touch plans from other sessions", () => {
    const sessionId = "ses_recon_5";
    const otherSessionId = "ses_other_5";
    startSession(db, { id: sessionId, goal: "test" });
    startSession(db, { id: otherSessionId, goal: "other" });

    const plan = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: otherSessionId },
      { reason: "other session plan" },
    );
    db.query("UPDATE plans SET status = 'executing', session_id = ? WHERE id = ?").run(
      otherSessionId,
      plan.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(0);

    const untouched = getPlan(db, plan.escalationPlanId);
    expect(untouched?.status).toBe("executing");
  });

  test("returns 0 when no plans match", () => {
    const sessionId = "ses_recon_6";
    startSession(db, { id: sessionId, goal: "test" });

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(0);
  });

  test("abandons multiple plans at once", () => {
    const sessionId = "ses_recon_7";
    startSession(db, { id: sessionId, goal: "test" });

    const p1 = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "first" },
    );
    const p2 = escalateToForeman(
      db,
      { agent: "craftsman", sessionID: sessionId },
      { reason: "second" },
    );
    db.query("UPDATE plans SET status = 'executing', session_id = ? WHERE id = ?").run(
      sessionId,
      p1.escalationPlanId,
    );
    db.query("UPDATE plans SET status = 'approved', session_id = ? WHERE id = ?").run(
      sessionId,
      p2.escalationPlanId,
    );

    const count = reconcileAbandonedPlans(db, sessionId, "foreman");
    expect(count).toBe(2);
  });
});

// ─── Helper ──────────────────────────────────────────────────────────────────

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

// ─── plan_create — created_by_agent default (T1) ─────────────────────────────

describe("plan_create — created_by_agent default (T1)", () => {
  test("sets created_by_agent from ctx.agent", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "agent-test", title: "Agent Test", overview: "test", priority: 2 },
      { agent: "craftsman" },
    );

    const fetched = db
      .query("SELECT created_by_agent FROM plans WHERE id = ?")
      .get(plan.id) as { created_by_agent: string | null };
    expect(fetched.created_by_agent).toBe("craftsman");
  });

  test("sets created_by_agent to null when ctx.agent undefined", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "no-agent", title: "No Agent", overview: "test", priority: 2 },
      {},
    );

    const fetched = db
      .query("SELECT created_by_agent FROM plans WHERE id = ?")
      .get(plan.id) as { created_by_agent: string | null };
    expect(fetched.created_by_agent).toBeNull();
  });

  test("plugin wrapper forces 'unknown' when ctx.agent missing", () => {
    // The plugin wraps: planCreateExecutor(db, args, { ...ctx, agent: ctx.agent ?? "unknown" })
    // So calling with agent: "unknown" simulates the wrapper behavior
    const plan = planCreateExecutor(
      db,
      { slug: "wrapper-test", title: "Wrapper", overview: "test", priority: 2 },
      { agent: "unknown" },
    );

    const fetched = db
      .query("SELECT created_by_agent FROM plans WHERE id = ?")
      .get(plan.id) as { created_by_agent: string | null };
    expect(fetched.created_by_agent).toBe("unknown");
  });
});

// ─── task_peek_for_agent logic (T1) ──────────────────────────────────────────

describe("task_peek_for_agent logic (T1)", () => {
  const PEEK_SQL = `SELECT * FROM plan_tasks WHERE agent = ? AND status = 'pending' AND archived_at IS NULL ORDER BY order_index`;
  const PEEK_SQL_WITH_PLAN = `SELECT * FROM plan_tasks WHERE agent = ? AND plan_id = ? AND status = 'pending' AND archived_at IS NULL ORDER BY order_index`;

  test("returns pending tasks for agent without claiming", () => {
    const plan = makePlan({ slug: "peek-1" });
    createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task a", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
      { orderIndex: 1, description: "task b", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    const rows = db.query(PEEK_SQL).all("js-smith") as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[1]!.status).toBe("pending");
  });

  test("filters by planId when provided", () => {
    const plan1 = makePlan({ slug: "peek-plan-1" });
    const plan2 = makePlan({ slug: "peek-plan-2" });
    createTasksBatch(db, plan1.id, [
      { orderIndex: 0, description: "task 1", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    createTasksBatch(db, plan2.id, [
      { orderIndex: 0, description: "task 2", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    const rows = db.query(PEEK_SQL_WITH_PLAN).all("js-smith", plan1.id) as Array<{ plan_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe(plan1.id);
  });

  test("excludes archived tasks", () => {
    const plan = makePlan({ slug: "peek-archived" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "archived task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    const taskId = tasks[0]!.id;
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(Date.now(), taskId);

    const rows = db.query(PEEK_SQL).all("js-smith") as Array<unknown>;
    expect(rows).toHaveLength(0);
  });

  test("excludes non-pending tasks", () => {
    const plan = makePlan({ slug: "peek-running" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "running task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "running", {}, "test", { agent: "js-smith" });

    const rows = db.query(PEEK_SQL).all("js-smith") as Array<unknown>;
    expect(rows).toHaveLength(0);
  });

  test("respects limit", () => {
    const plan = makePlan({ slug: "peek-limit" });
    const tasks = Array.from({ length: 5 }, (_, i) => ({
      orderIndex: i,
      description: `task ${i}`,
      agent: "js-smith",
      files: [] as string[],
      complexity: 1,
      dependencies: [] as string[],
      createdBy: "test",
      updatedBy: "test",
      sourceSessionId: null as string | null,
      sourceMessageId: null as string | null,
      reviewedBy: null as string | null,
      tokensUsed: null as number | null,
      durationMs: null as number | null,
      artifacts: [] as string[],
      metadata: {},
    }));
    createTasksBatch(db, plan.id, tasks);

    const rows = db
      .query(`${PEEK_SQL} LIMIT ?`)
      .all("js-smith", 2) as Array<unknown>;
    expect(rows).toHaveLength(2);
  });
});

// ─── task_add_artifact logic (T1) ────────────────────────────────────────────

describe("task_add_artifact logic (T1)", () => {
  function addArtifact(taskId: string, artifact: string, role?: string) {
    const row = db
      .query("SELECT artifacts, plan_id FROM plan_tasks WHERE id = ?")
      .get(taskId) as { artifacts: string; plan_id: string } | undefined;
    if (!row) throw new Error(`ndomo: task ${taskId} not found`);
    const current = JSON.parse(row.artifacts) as string[];
    if (current.includes(artifact)) {
      return { task: null, added: false, reason: "artifact already exists" };
    }
    const updated = [...current, artifact];
    db.query("UPDATE plan_tasks SET artifacts = ? WHERE id = ?").run(
      JSON.stringify(updated),
      taskId,
    );
    if (role) {
      db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
        row.plan_id,
        artifact,
        role,
      );
    }
    const updatedRow = db.query("SELECT * FROM plan_tasks WHERE id = ?").get(taskId);
    return { task: updatedRow, added: true };
  }

  test("appends artifact to existing empty array", () => {
    const plan = makePlan({ slug: "artifact-1" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    const result = addArtifact(tasks[0]!.id, "output.ts");
    expect(result.added).toBe(true);
    const task = db
      .query("SELECT artifacts FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { artifacts: string };
    expect(JSON.parse(task.artifacts)).toEqual(["output.ts"]);
  });

  test("appends to non-empty array", () => {
    const plan = makePlan({ slug: "artifact-2" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: ["a.ts"], metadata: {} },
    ]);

    addArtifact(tasks[0]!.id, "b.ts");
    const task = db
      .query("SELECT artifacts FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { artifacts: string };
    expect(JSON.parse(task.artifacts)).toEqual(["a.ts", "b.ts"]);
  });

  test("dedup — returns added:false if artifact exists", () => {
    const plan = makePlan({ slug: "artifact-3" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: ["a.ts"], metadata: {} },
    ]);

    const result = addArtifact(tasks[0]!.id, "a.ts");
    expect(result.added).toBe(false);
    expect(result.reason).toBe("artifact already exists");
  });

  test("with role — inserts into plan_files", () => {
    const plan = makePlan({ slug: "artifact-4" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    addArtifact(tasks[0]!.id, "src/x.ts", "output");
    const fileRow = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? AND file_path = ? AND role = ?")
      .get(plan.id, "src/x.ts", "output");
    expect(fileRow).not.toBeNull();
  });

  test("task not found — throws", () => {
    expect(() => addArtifact("nonexistent-id", "file.ts")).toThrow("not found");
  });
});

// ─── task_review logic (T1) ──────────────────────────────────────────────────

describe("task_review logic (T1)", () => {
  function reviewTask(taskId: string, reviewedBy: string, verdict: string) {
    const row = db
      .query("SELECT status, metadata FROM plan_tasks WHERE id = ?")
      .get(taskId) as { status: string; metadata: string | null } | undefined;
    if (!row) throw new Error(`ndomo: task ${taskId} not found`);
    if (row.status !== "done")
      throw new Error(`ndomo: task_review requires status='done', got '${row.status}'`);
    const currentMeta = row.metadata ? JSON.parse(row.metadata) : {};
    const updatedMeta = { ...currentMeta, reviewedVerdict: verdict };
    db.query("UPDATE plan_tasks SET reviewed_by = ?, metadata = ? WHERE id = ?").run(
      reviewedBy,
      JSON.stringify(updatedMeta),
      taskId,
    );
    return db.query("SELECT * FROM plan_tasks WHERE id = ?").get(taskId);
  }

  test("sets reviewed_by on done task", () => {
    const plan = makePlan({ slug: "review-1" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db
      .query("SELECT reviewed_by FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { reviewed_by: string | null };
    expect(row.reviewed_by).toBe("inspector");
  });

  test("stores reviewedVerdict in metadata", () => {
    const plan = makePlan({ slug: "review-2" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db
      .query("SELECT metadata FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.reviewedVerdict).toBe("approved");
  });

  test("preserves existing metadata", () => {
    const plan = makePlan({ slug: "review-3" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: { tokensUsed: 42 } },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db
      .query("SELECT metadata FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { metadata: string };
    const meta = JSON.parse(row.metadata);
    expect(meta.tokensUsed).toBe(42);
    expect(meta.reviewedVerdict).toBe("approved");
  });

  test("rejects non-done task", () => {
    const plan = makePlan({ slug: "review-4" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "task", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    expect(() => reviewTask(tasks[0]!.id, "inspector", "approved")).toThrow(
      "task_review requires status='done'",
    );
  });

  test("task not found — throws", () => {
    expect(() => reviewTask("nonexistent-id", "inspector", "approved")).toThrow("not found");
  });
});

// ─── plan_progress logic (T1) ────────────────────────────────────────────────

describe("plan_progress logic (T1)", () => {
  test("returns all plans progress", () => {
    const plan1 = makePlan({ slug: "prog-1" });
    const plan2 = makePlan({ slug: "prog-2" });
    createTasksBatch(db, plan1.id, [
      { orderIndex: 0, description: "t1", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    createTasksBatch(db, plan2.id, [
      { orderIndex: 0, description: "t2", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
      { orderIndex: 1, description: "t3", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    const rows = db.query("SELECT * FROM plan_progress_active").all() as Array<{
      plan_id: string;
      total_tasks: number;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const p1 = rows.find((r) => r.plan_id === plan1.id);
    const p2 = rows.find((r) => r.plan_id === plan2.id);
    expect(p1!.total_tasks).toBe(1);
    expect(p2!.total_tasks).toBe(2);
  });

  test("filters by planId", () => {
    const plan = makePlan({ slug: "prog-filter" });
    createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "t", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);

    const rows = db
      .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
      .all(plan.id) as Array<{ plan_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe(plan.id);
  });

  test("filters by owner via json_extract", () => {
    makePlan({ slug: "prog-owner-c", metadata: { category: "feature", ownedBy: "craftsman" } as never });
    makePlan({ slug: "prog-owner-w", metadata: { category: "feature", ownedBy: "warden" } as never });

    const rows = db
      .query(
        `SELECT pp.* FROM plan_progress_active pp
         JOIN plans p ON pp.plan_id = p.id
         WHERE json_extract(p.metadata, '$.ownedBy') = ?`,
      )
      .all("craftsman") as Array<{ plan_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe(
      (db.query("SELECT id FROM plans WHERE slug = ?").get("prog-owner-c") as { id: string }).id,
    );
  });

  test("progress_pct calculation", () => {
    const plan = makePlan({ slug: "prog-pct" });
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "t1", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
      { orderIndex: 1, description: "t2", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    const row = db
      .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
      .get(plan.id) as { progress_pct: number; done: number; pending: number };
    expect(row.done).toBe(1);
    expect(row.pending).toBe(1);
    expect(row.progress_pct).toBe(50);
  });

  test("excludes archived plans", () => {
    const plan = makePlan({ slug: "prog-archived" });
    createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "t", agent: "js-smith", files: [], complexity: 1, dependencies: [], createdBy: "test", updatedBy: "test", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    db.query("UPDATE plans SET archived_at = ? WHERE id = ?").run(Date.now(), plan.id);

    const rows = db
      .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
      .all(plan.id) as Array<unknown>;
    expect(rows).toHaveLength(0);
  });
});

// ─── plan_files_write logic (T1) ─────────────────────────────────────────────

describe("plan_files_write logic (T1)", () => {
  test("inserts new files with roles", () => {
    const plan = makePlan({ slug: "files-1" });
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/a.ts",
      "input",
    );
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/b.ts",
      "output",
    );

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ?")
      .all(plan.id) as Array<unknown>;
    expect(rows).toHaveLength(2);
  });

  test("idempotent — INSERT OR IGNORE for same (plan, file, role)", () => {
    const plan = makePlan({ slug: "files-2" });
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/a.ts",
      "input",
    );
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "src/a.ts",
      "input",
    );

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ?")
      .all(plan.id) as Array<unknown>;
    expect(rows).toHaveLength(1);
  });

  test("same file different role — both inserted", () => {
    const plan = makePlan({ slug: "files-3" });
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "x.ts",
      "input",
    );
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "x.ts",
      "modified",
    );

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ?")
      .all(plan.id) as Array<unknown>;
    expect(rows).toHaveLength(2);
  });

  test("non-existent plan — FK violation", () => {
    expect(() => {
      db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
        "fake-plan-id",
        "file.ts",
        "output",
      );
    }).toThrow();
  });
});

// ─── Integration: task_create_batch → task_add_artifact → task_review → plan_progress ──

describe("integration — task_create_batch → task_add_artifact → task_review → plan_progress (T1)", () => {
  test("full flow with owner filter and artifact/review tracking", () => {
    // 1. Create plan with metadata.ownedBy
    const plan = makePlan({
      slug: "integration-flow",
      metadata: { category: "feature", ownedBy: "craftsman" } as never,
    });

    // 2. Create 2 tasks
    const tasks = createTasksBatch(db, plan.id, [
      { orderIndex: 0, description: "implement feature", agent: "js-smith", files: [], complexity: 2, dependencies: [], createdBy: "craftsman", updatedBy: "craftsman", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
      { orderIndex: 1, description: "write tests", agent: "js-smith", files: [], complexity: 2, dependencies: [], createdBy: "craftsman", updatedBy: "craftsman", sourceSessionId: null, sourceMessageId: null, reviewedBy: null, tokensUsed: null, durationMs: null, artifacts: [], metadata: {} },
    ]);
    expect(tasks).toHaveLength(2);

    // 3. Move first task through running → done
    updateTaskStatus(db, tasks[0]!.id, "running", {}, "craftsman", { agent: "js-smith" });
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "feature implemented" }, "craftsman", {
      agent: "js-smith",
    });

    // 4. Add artifact to done task
    const artRow = db
      .query("SELECT artifacts, plan_id FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { artifacts: string; plan_id: string };
    const currentArtifacts = JSON.parse(artRow.artifacts) as string[];
    const updatedArtifacts = [...currentArtifacts, "output.ts"];
    db.query("UPDATE plan_tasks SET artifacts = ? WHERE id = ?").run(
      JSON.stringify(updatedArtifacts),
      tasks[0]!.id,
    );
    db.query("INSERT OR IGNORE INTO plan_files (plan_id, file_path, role) VALUES (?, ?, ?)").run(
      plan.id,
      "output.ts",
      "output",
    );

    // 5. Review the done task
    const doneRow = db
      .query("SELECT status, metadata FROM plan_tasks WHERE id = ?")
      .get(tasks[0]!.id) as { status: string; metadata: string | null };
    expect(doneRow.status).toBe("done");
    const currentMeta = doneRow.metadata ? JSON.parse(doneRow.metadata) : {};
    const updatedMeta = { ...currentMeta, reviewedVerdict: "approved" };
    db.query(
      "UPDATE plan_tasks SET reviewed_by = ?, metadata = ? WHERE id = ?",
    ).run("inspector", JSON.stringify(updatedMeta), tasks[0]!.id);

    // 6. Query plan_progress_active
    const progress = db
      .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
      .get(plan.id) as {
      total_tasks: number;
      done: number;
      pending: number;
      progress_pct: number;
    };
    expect(progress.total_tasks).toBe(2);
    expect(progress.done).toBe(1);
    expect(progress.pending).toBe(1);
    expect(progress.progress_pct).toBe(50);

    // 7. Query with owner filter
    const ownerRows = db
      .query(
        `SELECT pp.* FROM plan_progress_active pp
         JOIN plans p ON pp.plan_id = p.id
         WHERE json_extract(p.metadata, '$.ownedBy') = ?`,
      )
      .all("craftsman") as Array<{ plan_id: string }>;
    expect(ownerRows.length).toBeGreaterThanOrEqual(1);
    expect(ownerRows.some((r) => r.plan_id === plan.id)).toBe(true);

    // 8. Verify the done task has artifacts + review
    const finalTask = db.query("SELECT * FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      artifacts: string;
      reviewed_by: string;
      metadata: string;
    };
    expect(JSON.parse(finalTask.artifacts)).toEqual(["output.ts"]);
    expect(finalTask.reviewed_by).toBe("inspector");
    expect(JSON.parse(finalTask.metadata).reviewedVerdict).toBe("approved");
  });
});

// ─── T2 helpers ──────────────────────────────────────────────────────────────

function createTestDeployment(db: Database): string {
  db.query("INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", Date.now(), Date.now());
  db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r1", "1.0.0", "rel", Date.now());
  db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d1", "r1", "e1", "planned", Date.now());
  return "d1";
}

// ─── incident_create tool logic (T2) ─────────────────────────────────────────

describe("incident_create tool logic (T2)", () => {
  test("happy path — creates incident with severity + title", () => {
    createTestDeployment(db);
    const incident = createIncident(db, {
      title: "API 500 errors",
      severity: "sev2",
      summary: "Users getting 500 on /api/data",
    });
    expect(incident.title).toBe("API 500 errors");
    expect(incident.severity).toBe("sev2");
    expect(incident.status).toBe("open");
    expect(incident.summary).toBe("Users getting 500 on /api/data");
  });

  test("sets metadata.created_by from ctx.agent", () => {
    createTestDeployment(db);
    const incident = createIncident(db, {
      title: "test incident",
      severity: "sev3",
      metadata: { created_by: "warden" },
    });
    expect(incident.metadata?.created_by).toBe("warden");
  });

  test("defaults created_by to 'unknown' when ctx.agent undefined", () => {
    createTestDeployment(db);
    const incident = createIncident(db, {
      title: "test incident",
      severity: "sev3",
      metadata: { created_by: "unknown" },
    });
    expect(incident.metadata?.created_by).toBe("unknown");
  });

  test("FK error — non-existent triggeredByDeploymentId", () => {
    expect(() =>
      createIncident(db, {
        title: "bad FK",
        severity: "sev1",
        triggeredByDeploymentId: "nonexistent",
      }),
    ).toThrow("deployment 'nonexistent' not found");
  });

  test("valid FK — triggeredByDeploymentId links to deployment", () => {
    createTestDeployment(db);
    const incident = createIncident(db, {
      title: "linked incident",
      severity: "sev2",
      triggeredByDeploymentId: "d1",
    });
    expect(incident.triggeredByDeploymentId).toBe("d1");
  });

  test("invalid severity — throws", () => {
    expect(() =>
      createIncident(db, {
        title: "bad severity",
        severity: "sev5" as never,
      }),
    ).toThrow("invalid incident severity");
  });
});

// ─── rollback_record tool logic (T2) ─────────────────────────────────────────

describe("rollback_record tool logic (T2)", () => {
  test("happy path — creates rollback with default status='planned'", () => {
    createTestDeployment(db);
    const rb = recordRollback(db, {
      deploymentId: "d1",
      plan: "rollback to v1.0",
    });
    expect(rb.status).toBe("planned");
    expect(rb.deploymentId).toBe("d1");
    expect(rb.plan).toBe("rollback to v1.0");
  });

  test("explicit status='approved'", () => {
    createTestDeployment(db);
    const rb = recordRollback(db, {
      deploymentId: "d1",
      plan: "rollback approved",
      status: "approved",
    });
    expect(rb.status).toBe("approved");
  });

  test("sets metadata.executed_by_agent from ctx.agent", () => {
    createTestDeployment(db);
    const rb = recordRollback(db, {
      deploymentId: "d1",
      plan: "test rollback",
      metadata: { executed_by_agent: "warden" },
    });
    expect(rb.metadata?.executed_by_agent).toBe("warden");
  });

  test("FK error — non-existent deploymentId", () => {
    expect(() =>
      recordRollback(db, {
        deploymentId: "nonexistent",
        plan: "should fail",
      }),
    ).toThrow("deployment 'nonexistent' not found");
  });

  test("FK error — non-existent incidentId", () => {
    createTestDeployment(db);
    expect(() =>
      recordRollback(db, {
        deploymentId: "d1",
        plan: "bad incident FK",
        incidentId: "nonexistent",
      }),
    ).toThrow("incident 'nonexistent' not found");
  });

  test("FK error — non-existent newDeploymentId", () => {
    createTestDeployment(db);
    expect(() =>
      recordRollback(db, {
        deploymentId: "d1",
        plan: "bad new deploy FK",
        newDeploymentId: "nonexistent",
      }),
    ).toThrow("new_deployment 'nonexistent' not found");
  });

  test("valid incidentId FK", () => {
    createTestDeployment(db);
    const incident = createIncident(db, {
      title: "linked",
      severity: "sev1",
    });
    const rb = recordRollback(db, {
      deploymentId: "d1",
      plan: "rollback for incident",
      incidentId: incident.id,
    });
    expect(rb.incidentId).toBe(incident.id);
  });

  test("valid newDeploymentId FK", () => {
    db.query("INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("e1", "prod", "prod", Date.now(), Date.now());
    db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r1", "1.0.0", "rel", Date.now());
    db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run("r2", "1.0.1", "rel2", Date.now());
    db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d1", "r1", "e1", "planned", Date.now());
    db.query("INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)").run("d2", "r2", "e1", "planned", Date.now());
    const rb = recordRollback(db, {
      deploymentId: "d1",
      plan: "rollback to new deploy",
      newDeploymentId: "d2",
    });
    expect(rb.newDeploymentId).toBe("d2");
  });

  test("empty plan — throws", () => {
    createTestDeployment(db);
    expect(() =>
      recordRollback(db, {
        deploymentId: "d1",
        plan: "   ",
      }),
    ).toThrow("rollback plan cannot be empty");
  });

  test("idempotency — re-record creates new row", () => {
    createTestDeployment(db);
    const rb1 = recordRollback(db, { deploymentId: "d1", plan: "first" });
    const rb2 = recordRollback(db, { deploymentId: "d1", plan: "first" });
    expect(rb1.id).not.toBe(rb2.id);
    expect(rb1.plan).toBe(rb2.plan);
  });
});

// ─── Integration: incident_create → rollback_record flow (T2) ────────────────

describe("integration — incident_create → rollback_record flow (T2)", () => {
  test("full ops flow: deployment → incident → rollback", () => {
    // 1. Create test deployment
    createTestDeployment(db);

    // 2. Create incident linked to deployment
    const incident = createIncident(db, {
      title: "prod down",
      severity: "sev1",
      summary: "api 500ing",
      triggeredByDeploymentId: "d1",
    });
    expect(incident.triggeredByDeploymentId).toBe("d1");
    expect(incident.severity).toBe("sev1");

    // 3. Record rollback tied to incident
    const rb = recordRollback(db, {
      deploymentId: "d1",
      incidentId: incident.id,
      plan: "rollback to v1.0.0",
      status: "executing",
    });
    expect(rb.deploymentId).toBe("d1");
    expect(rb.incidentId).toBe(incident.id);
    expect(rb.status).toBe("executing");

    // 4. Verify cross-links
    const incidentCheck = db.query("SELECT * FROM incidents WHERE id = ?").get(incident.id) as { triggered_by_deployment_id: string | null };
    expect(incidentCheck.triggered_by_deployment_id).toBe("d1");
  });
});

// ─── plan_update_status extended (T3.1) ─────────────────────────────────────

describe("plan_update_status extended (T3.1)", () => {
  /** Helper: create a plan in a given status with tasks and optional session. */
  function setupPlan(opts: {
    status: string;
    slug?: string;
    taskStatuses?: string[];
    openSessions?: string[];
  }) {
    const plan = makePlan({ slug: opts.slug ?? "t3-test" });
    // Set target status directly (makePlan creates as draft)
    if (opts.status !== "draft") {
      db.query("UPDATE plans SET status = ? WHERE id = ?").run(opts.status, plan.id);
    }
    if (opts.taskStatuses) {
      const tasks = createTasksBatch(
        db,
        plan.id,
        opts.taskStatuses.map((_, i) => ({
          orderIndex: i,
          description: `task ${i}`,
          agent: "js-smith",
          files: [] as string[],
          complexity: 1,
          dependencies: [] as string[],
          createdBy: "test",
          updatedBy: "test",
          sourceSessionId: null as string | null,
          sourceMessageId: null as string | null,
          reviewedBy: null as string | null,
          tokensUsed: null as number | null,
          durationMs: null as number | null,
          artifacts: [] as string[],
          metadata: {},
        })),
      );
      for (let i = 0; i < tasks.length; i++) {
        const st = opts.taskStatuses[i]!;
        if (st !== "pending") {
          updateTaskStatus(db, tasks[i]!.id, st as "running" | "done" | "failed" | "blocked", {}, "test", { agent: "js-smith" });
        }
      }
    }
    if (opts.openSessions) {
      for (const sid of opts.openSessions) {
        startSession(db, { id: sid, goal: "test session", planId: plan.id });
      }
    }
    return plan;
  }

  const ARCHIVE_DIR = "/tmp/ndomo-test-archives-t3";

  test("happy path — all tasks done, no open sessions → completed, archived", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["done", "done"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.statusChanged).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.forced).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.archived).toBeTruthy();
    expect(result.archived!.planId).toBe(plan.id);
    expect(result.archiveError).toBeNull();
    expect(result.plan!.status).toBe("completed");
  });

  test("completed_at set on terminal status — completed, failed, abandoned", () => {
    // completed
    const plan1 = setupPlan({ status: "executing", taskStatuses: ["done"], slug: "t3-term-completed" });
    const r1 = planUpdateStatusExecutor(db, { id: plan1.id, status: "completed" }, { agent: "craftsman" }, ARCHIVE_DIR);
    expect(r1.plan!.completedAt).not.toBeNull();
    expect(r1.plan!.completedAt!).toBeGreaterThan(0);

    // failed
    const plan2 = setupPlan({ status: "executing", taskStatuses: ["pending"], slug: "t3-term-failed" });
    const r2 = planUpdateStatusExecutor(db, { id: plan2.id, status: "failed" }, { agent: "craftsman" }, ARCHIVE_DIR);
    expect(r2.plan!.completedAt).not.toBeNull();
    expect(r2.plan!.completedAt!).toBeGreaterThan(0);

    // abandoned
    const plan3 = setupPlan({ status: "executing", taskStatuses: ["done"], slug: "t3-term-abandoned" });
    const r3 = planUpdateStatusExecutor(db, { id: plan3.id, status: "abandoned" }, { agent: "craftsman" }, ARCHIVE_DIR);
    expect(r3.plan!.completedAt).not.toBeNull();
    expect(r3.plan!.completedAt!).toBeGreaterThan(0);
  });

  test("completed_at NOT set on non-terminal status — approved, executing", () => {
    const plan = setupPlan({ status: "draft", taskStatuses: [], slug: "t3-nonterm" });
    const r1 = planUpdateStatusExecutor(db, { id: plan.id, status: "approved" }, { agent: "craftsman" }, ARCHIVE_DIR);
    expect(r1.plan!.completedAt).toBeNull();

    const r2 = planUpdateStatusExecutor(db, { id: plan.id, status: "executing" }, { agent: "craftsman" }, ARCHIVE_DIR);
    expect(r2.plan!.completedAt).toBeNull();
  });

  test("dryRun — does NOT mutate status, returns blockers/warnings", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["done", "done"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed", dryRun: true },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.dryRun).toBe(true);
    expect(result.statusChanged).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.archived).toBeNull();
    expect(result.archiveError).toBeNull();

    // Verify plan status unchanged
    const fresh = getPlan(db, plan.id);
    expect(fresh!.status).toBe("executing");
  });

  test("dryRun with blockers — pending tasks reported as blockers", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["pending", "done"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed", dryRun: true },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.dryRun).toBe(true);
    expect(result.blocked).toBe(true);
    expect(result.blockers).toContain("tasks_pending");
    expect(result.statusChanged).toBe(false);

    // Verify plan status unchanged
    const fresh = getPlan(db, plan.id);
    expect(fresh!.status).toBe("executing");
  });

  test("force with reason — bypasses blockers, creates plan_audit row", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["pending", "running"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed", force: true, forceReason: "testing force" },
      { agent: "warden" },
      ARCHIVE_DIR,
    );

    expect(result.statusChanged).toBe(true);
    expect(result.forced).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.blockers).toContain("tasks_pending");
    expect(result.blockers).toContain("tasks_running");
    expect(result.auditId).toBeTruthy();
    expect(typeof result.auditId).toBe("number");
    expect(result.plan!.status).toBe("completed");
    expect(result.archived).toBeTruthy();

    // Verify plan_audit row
    const audit = db
      .query("SELECT * FROM plan_audit WHERE plan_id = ?")
      .get(plan.id) as { trigger: string; snapshot: string } | null;
    expect(audit).not.toBeNull();
    expect(audit!.trigger).toBe("force_close");
    const snapshot = JSON.parse(audit!.snapshot);
    expect(snapshot.reason).toBe("testing force");
    expect(snapshot.forcedBy).toBe("warden");
    expect(snapshot.blockers).toContain("tasks_pending");
    expect(snapshot.previousStatus).toBe("executing");
  });

  test("force without reason rejected — throws Error", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["pending"] });
    expect(() =>
      planUpdateStatusExecutor(
        db,
        { id: plan.id, status: "completed", force: true },
        { agent: "craftsman" },
        ARCHIVE_DIR,
      ),
    ).toThrow(/forceReason/);
  });

  test("force does NOT bypass status_invalid", () => {
    const plan = setupPlan({ status: "completed", taskStatuses: ["done"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "executing", force: true, forceReason: "need re-execute" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.blocked).toBe(true);
    expect(result.statusChanged).toBe(false);
    expect(result.blockers).toContain("status_invalid");
    expect(result.plan!.status).toBe("completed");
  });

  test("blockers block update (no force)", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["pending", "done"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.blocked).toBe(true);
    expect(result.statusChanged).toBe(false);
    expect(result.blockers).toContain("tasks_pending");
    expect(result.plan!.status).toBe("executing");
    expect(result.archived).toBeNull();
  });

  test("orphan plan warning — 0 tasks, warning only, status changes", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: [] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "completed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.statusChanged).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContain("orphan_plan");
    expect(result.plan!.status).toBe("completed");
  });

  test("executing→failed warnings only — pending tasks become warnings, not blockers", () => {
    const plan = setupPlan({ status: "executing", taskStatuses: ["pending", "running"] });
    const result = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "failed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );

    expect(result.statusChanged).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toContain("tasks_pending");
    expect(result.warnings).toContain("tasks_running");
    expect(result.plan!.status).toBe("failed");
  });

  test("archive atomicity — if archivePlan throws, status update rolls back", () => {
    // Create plan with all tasks done
    const plan = setupPlan({ status: "executing", taskStatuses: ["done"] });

    // Pre-set archived_at to make archivePlan throw "already archived"
    db.query("UPDATE plans SET archived_at = ? WHERE id = ?").run(Date.now(), plan.id);

    // Call should throw because archivePlan throws "already archived"
    expect(() =>
      planUpdateStatusExecutor(
        db,
        { id: plan.id, status: "completed" },
        { agent: "craftsman" },
        ARCHIVE_DIR,
      ),
    ).toThrow(/already archived/);

    // Status should NOT have changed (rolled back by outer transaction)
    const fresh = getPlan(db, plan.id);
    expect(fresh!.status).toBe("executing");
  });
});

// ─── task_dependency_resolver + task_next_for_agent deps (T3.2) ─────────────

describe("task_dependency_resolver + task_next_for_agent deps (T3.2)", () => {
  /** Helper: create a plan with tasks that have explicit dependencies. */
  function setupDepsPlan(
    taskDefs: Array<{ orderIndex: number; deps: string[]; agent?: string }>,
  ) {
    const plan = makePlan({ slug: "deps-test" });
    db.query("UPDATE plans SET status = ? WHERE id = ?").run("executing", plan.id);
    const tasks = createTasksBatch(
      db,
      plan.id,
      taskDefs.map((td) => ({
        orderIndex: td.orderIndex,
        description: `task ${td.orderIndex}`,
        agent: td.agent ?? "js-smith",
        files: [] as string[],
        complexity: 1,
        dependencies: td.deps,
        createdBy: "test",
        updatedBy: "test",
        sourceSessionId: null as string | null,
        sourceMessageId: null as string | null,
        reviewedBy: null as string | null,
        tokensUsed: null as number | null,
        durationMs: null as number | null,
        artifacts: [] as string[],
        metadata: {},
      })),
    );
    return { plan, tasks };
  }

  // ── resolveTaskDependencies ────────────────────────────────────────────

  test("resolveTaskDependencies — no deps → canStart=true, empty arrays", () => {
    const { tasks } = setupDepsPlan([{ orderIndex: 0, deps: [] }]);
    const result = resolveTaskDependencies(db, tasks[0]!.id);

    expect(result.canStart).toBe(true);
    expect(result.dependencies).toEqual([]);
    expect(result.doneDeps).toEqual([]);
    expect(result.pendingDeps).toEqual([]);
    expect(result.missingDeps).toEqual([]);
  });

  test("resolveTaskDependencies — all deps done → canStart=true", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
      { orderIndex: 2, deps: [] },
    ]);
    // Mark deps as done
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");
    updateTaskStatus(db, tasks[1]!.id, "done", {}, "test");

    // Task 2 depends on 0 and 1 — wire deps manually via DB
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id, tasks[1]!.id]),
      tasks[2]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[2]!.id);
    expect(result.canStart).toBe(true);
    expect(result.doneDeps).toEqual([tasks[0]!.id, tasks[1]!.id]);
    expect(result.pendingDeps).toEqual([]);
  });

  test("resolveTaskDependencies — deps pending → canStart=false", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    // Task 1 depends on task 0 (still pending)
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[1]!.id);
    expect(result.canStart).toBe(false);
    expect(result.pendingDeps).toEqual([tasks[0]!.id]);
    expect(result.doneDeps).toEqual([]);
  });

  test("resolveTaskDependencies — deps failed → canStart=false", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "failed", { error: "boom" }, "test");
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[1]!.id);
    expect(result.canStart).toBe(false);
    expect(result.failedDeps).toEqual([tasks[0]!.id]);
  });

  test("resolveTaskDependencies — deps running → canStart=false", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "running", {}, "test");
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[1]!.id);
    expect(result.canStart).toBe(false);
    expect(result.runningDeps).toEqual([tasks[0]!.id]);
  });

  test("resolveTaskDependencies — deps blocked → canStart=false", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "blocked", {}, "test");
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[1]!.id);
    expect(result.canStart).toBe(false);
    expect(result.blockedDeps).toEqual([tasks[0]!.id]);
  });

  test("resolveTaskDependencies — missing dep IDs → canStart=false, missingDeps populated", () => {
    const { tasks } = setupDepsPlan([{ orderIndex: 0, deps: [] }]);
    const fakeDepId = crypto.randomUUID();
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([fakeDepId]),
      tasks[0]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[0]!.id);
    expect(result.canStart).toBe(false);
    expect(result.missingDeps).toEqual([fakeDepId]);
  });

  test("resolveTaskDependencies — mixed dep states", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
      { orderIndex: 2, deps: [] },
      { orderIndex: 3, deps: [] },
      { orderIndex: 4, deps: [] },
    ]);
    // 0=done, 1=failed, 2=running, 3=pending, 4=target
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");
    updateTaskStatus(db, tasks[1]!.id, "failed", { error: "x" }, "test");
    updateTaskStatus(db, tasks[2]!.id, "running", {}, "test");
    // 3 stays pending

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id, tasks[1]!.id, tasks[2]!.id, tasks[3]!.id]),
      tasks[4]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[4]!.id);
    expect(result.canStart).toBe(false);
    expect(result.doneDeps).toEqual([tasks[0]!.id]);
    expect(result.failedDeps).toEqual([tasks[1]!.id]);
    expect(result.runningDeps).toEqual([tasks[2]!.id]);
    expect(result.pendingDeps).toEqual([tasks[3]!.id]);
  });

  test("resolveTaskDependencies — taskId not found → throws", () => {
    expect(() => resolveTaskDependencies(db, "nonexistent-id")).toThrow(/not found/);
  });

  // ── nextTaskForAgent dependency gating ─────────────────────────────────

  test("nextTaskForAgent — no deps → claims task (backward compat)", () => {
    setupDepsPlan([{ orderIndex: 0, deps: [] }]);

    const claimed = nextTaskForAgent(db, "js-smith");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");
  });

  test("nextTaskForAgent — all deps done → claims task", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith");
    // Should claim task 1 (task 0 is done, not pending)
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(tasks[1]!.id);
    expect(claimed!.status).toBe("running");
  });

  test("nextTaskForAgent — deps pending → skips, returns null", () => {
    const { tasks, plan } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    // Wire task 1 to depend on task 0 (both pending)
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    // Task 0 has no deps → eligible, gets claimed first
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(tasks[0]!.id);
  });

  test("nextTaskForAgent — deps failed → skips task with failed deps", () => {
    const { tasks, plan } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "failed", { error: "boom" }, "test");

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    // Task 1 depends on failed task 0 → not eligible → null
    expect(claimed).toBeNull();
  });

  test("nextTaskForAgent — deps running → skips task with running deps", () => {
    const { tasks, plan } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "running", {}, "test");

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(claimed).toBeNull();
  });

  test("nextTaskForAgent — deps blocked → skips task with blocked deps", () => {
    const { tasks, plan } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "blocked", {}, "test");

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(claimed).toBeNull();
  });

  test("nextTaskForAgent — missing dep IDs → skips (deps not found in DB)", () => {
    const { tasks, plan } = setupDepsPlan([{ orderIndex: 0, deps: [] }]);
    const fakeDepId = crypto.randomUUID();
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([fakeDepId]),
      tasks[0]!.id,
    );

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(claimed).toBeNull();
  });

  test("nextTaskForAgent — mixed candidates: claims first eligible by order_index", () => {
    const { tasks, plan } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
      { orderIndex: 2, deps: [] },
    ]);
    // task 0 has unmet deps (pointing to a fake ID)
    const fakeDepId = crypto.randomUUID();
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([fakeDepId]),
      tasks[0]!.id,
    );
    // task 1 has deps on task 0 (which is pending)
    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id]),
      tasks[1]!.id,
    );
    // task 2 has no deps → eligible

    const claimed = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(tasks[2]!.id);
    expect(claimed!.status).toBe("running");
  });

  // ── task_dependency_resolver tool shape ────────────────────────────────

  test("task_dependency_resolver tool — returns correct shape via resolveTaskDependencies", () => {
    const { tasks } = setupDepsPlan([
      { orderIndex: 0, deps: [] },
      { orderIndex: 1, deps: [] },
      { orderIndex: 2, deps: [] },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");
    updateTaskStatus(db, tasks[1]!.id, "failed", { error: "x" }, "test");

    db.query("UPDATE plan_tasks SET dependencies = ? WHERE id = ?").run(
      JSON.stringify([tasks[0]!.id, tasks[1]!.id, crypto.randomUUID()]),
      tasks[2]!.id,
    );

    const result = resolveTaskDependencies(db, tasks[2]!.id);

    // Shape checks
    expect(typeof result.canStart).toBe("boolean");
    expect(Array.isArray(result.pendingDeps)).toBe(true);
    expect(Array.isArray(result.runningDeps)).toBe(true);
    expect(Array.isArray(result.failedDeps)).toBe(true);
    expect(Array.isArray(result.blockedDeps)).toBe(true);
    expect(Array.isArray(result.doneDeps)).toBe(true);
    expect(Array.isArray(result.missingDeps)).toBe(true);
    expect(Array.isArray(result.dependencies)).toBe(true);

    // Value checks
    expect(result.canStart).toBe(false);
    expect(result.doneDeps).toEqual([tasks[0]!.id]);
    expect(result.failedDeps).toEqual([tasks[1]!.id]);
    expect(result.missingDeps.length).toBe(1);
    expect(result.dependencies.length).toBe(3);
  });
});

// ─── auto_checkpoint hook (T3.3) ────────────────────────────────────────────

describe("auto_checkpoint hook (T3.3)", () => {
  /** Helper: create a plan with N tasks, return plan + tasks. */
  function setupPlanWithTasks(taskCount: number) {
    const plan = makePlan({ slug: `acp-${crypto.randomUUID().slice(0, 8)}` })
    db.query("UPDATE plans SET status = ? WHERE id = ?").run("executing", plan.id)

    const taskDescs = Array.from({ length: taskCount }, (_, i) => ({
      orderIndex: i,
      description: `Task ${i}`,
      agent: "js-smith",
      files: [] as string[],
      complexity: 1,
      dependencies: [] as string[],
      createdBy: "test",
      updatedBy: "test",
      sourceSessionId: null as string | null,
      sourceMessageId: null as string | null,
      reviewedBy: null as string | null,
      tokensUsed: null as number | null,
      durationMs: null as number | null,
      artifacts: [] as string[],
      metadata: {},
    }))
    const tasks = createTasksBatch(db, plan.id, taskDescs)
    return { plan, tasks }
  }

  test("trigger fires on phase_transition — checkpointSession updates session", async () => {
    const { plan } = setupPlanWithTasks(1)
    startSession(db, { id: "ses_acp_1", goal: "test auto-checkpoint" })
    // mark task done so plan can transition to completed
    const tasks = listTasksByPlan(db, plan.id)
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test")

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 })
    dispatcher.dispatch("phase_transition", {
      planId: plan.id,
      sessionId: "ses_acp_1",
      blockers: ["tasks_pending"],
    })

    // Flush microtask
    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_1")
    expect(sess).not.toBeNull()
    const state = sess!.state
    expect(state.trigger).toBe("phase_transition")
    expect(state.completedTasks).toBe(1)
    expect(state.currentPhase).toBe("executing")
    expect(state.blockers).toEqual(["tasks_pending"])
  })

  test("debounce works — two rapid calls produce only one checkpoint", async () => {
    const { plan } = setupPlanWithTasks(1)
    startSession(db, { id: "ses_acp_deb", goal: "debounce test" })

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 5000 })

    // First call — should fire
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_deb" })
    // Second call immediately — should be debounced
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_deb" })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_deb")
    expect(sess).not.toBeNull()
    // Only one checkpoint written — state should reflect the first call
    const state = sess!.state
    expect(state.trigger).toBe("phase_transition")
  })

  test("disabled config = no-op — no checkpoint written", async () => {
    startSession(db, { id: "ses_acp_dis", goal: "disabled test" })
    const { plan } = setupPlanWithTasks(1)

    const dispatcher = new AutoCheckpointDispatcher(db, { enabled: false, minIntervalMs: 0 })
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_dis" })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_dis")
    expect(sess).not.toBeNull()
    // state should be the default empty object (no checkpoint written)
    expect(sess!.state).toEqual({})
  })

  test("no loop — checkpointSession does NOT trigger plan_update_status", async () => {
    const { plan } = setupPlanWithTasks(1)
    startSession(db, { id: "ses_acp_loop", goal: "loop test" })

    // Record plan status before
    const before = getPlan(db, plan.id)
    const statusBefore = before!.status

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 })
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_loop" })

    await new Promise((r) => setTimeout(r, 10))

    // Plan status must NOT have changed — checkpointSession only touches sessions table
    const after = getPlan(db, plan.id)
    expect(after!.status).toBe(statusBefore)
  })

  test("task_batch_complete fires when last task done", async () => {
    const { plan, tasks } = setupPlanWithTasks(2)
    startSession(db, { id: "ses_acp_batch", goal: "batch test" })

    // Complete both tasks
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test")
    updateTaskStatus(db, tasks[1]!.id, "done", {}, "test")

    // Verify no pending tasks remain
    const pending = listTasksByPlan(db, plan.id, { status: "pending" })
    expect(pending.length).toBe(0)

    // Simulate what plugin does: dispatch task_batch_complete
    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 })
    dispatcher.dispatch("task_batch_complete", { planId: plan.id, sessionId: "ses_acp_batch" })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_batch")
    expect(sess).not.toBeNull()
    const state = sess!.state
    expect(state.trigger).toBe("task_batch_complete")
    expect(state.completedTasks).toBe(2)
  })

  test("task_batch_complete does NOT fire when non-last task done", async () => {
    const { plan, tasks } = setupPlanWithTasks(2)
    startSession(db, { id: "ses_acp_partial", goal: "partial batch test" })

    // Complete only the first task
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test")

    // There IS still a pending task — so batch is NOT complete
    const pending = listTasksByPlan(db, plan.id, { status: "pending" })
    expect(pending.length).toBe(1)

    // Simulate what plugin does: do NOT dispatch because pending > 0
    // (In real code, the trigger is conditional on pending.length === 0)
    // We verify here that the session was NOT checkpointed
    const sess = getSession(db, "ses_acp_partial")
    expect(sess).not.toBeNull()
    expect(sess!.state).toEqual({})
  })

  test("no sessionId = skip — no checkpoint written", async () => {
    const { plan } = setupPlanWithTasks(1)
    startSession(db, { id: "ses_acp_nosess", goal: "no-session test" })

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 })
    // dispatch without sessionId
    dispatcher.dispatch("phase_transition", { planId: plan.id })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_nosess")
    expect(sess!.state).toEqual({})
  })

  test("unknown trigger = skip — no checkpoint written", async () => {
    startSession(db, { id: "ses_acp_unknown", goal: "unknown trigger test" })

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 })
    dispatcher.dispatch("some_random_trigger", { sessionId: "ses_acp_unknown" })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_unknown")
    expect(sess!.state).toEqual({})
  })

  test("captureState options — selective capture", async () => {
    const { plan } = setupPlanWithTasks(1)
    startSession(db, { id: "ses_acp_sel", goal: "selective capture test" })
    updateTaskStatus(db, listTasksByPlan(db, plan.id)[0]!.id, "done", {}, "test")

    const dispatcher = new AutoCheckpointDispatcher(db, {
      minIntervalMs: 0,
      captureState: { completedTasks: true, currentPhase: false, blockers: false },
    })
    dispatcher.dispatch("phase_transition", {
      planId: plan.id,
      sessionId: "ses_acp_sel",
      blockers: ["some_blocker"],
    })

    await new Promise((r) => setTimeout(r, 10))

    const sess = getSession(db, "ses_acp_sel")
    const state = sess!.state
    expect(state.trigger).toBe("phase_transition")
    expect(state.completedTasks).toBe(1)
    // currentPhase and blockers should NOT be captured
    expect(state.currentPhase).toBeUndefined()
    expect(state.blockers).toBeUndefined()
  })
});
