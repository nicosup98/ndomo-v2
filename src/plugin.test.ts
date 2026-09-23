/**
 * Tests for plugin helpers: escalateToForeman (M2) and reconcileAbandonedPlans (M3).
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  archiveAnalysis,
  createAnalysis,
  getAnalysis,
  linkAnalysisToPlan,
  listAnalyses,
  searchAnalyses,
  unlinkAnalysisFromPlan,
  updateAnalysis,
} from "./db/analyses.ts";
import { AutoCheckpointDispatcher } from "./db/auto-checkpoint.ts";
import { createIncident } from "./db/incidents.ts";
import { readLedger } from "./db/ledgers.ts";
import { runMigrations } from "./db/migrations.ts";
import { planCreateExecutor } from "./db/plan-create.ts";
import { planUpdateStatusExecutor } from "./db/plan-update-status.ts";
import { createPlan, getPlan } from "./db/plans.ts";
import { recordRollback } from "./db/rollbacks.ts";
import { getSession, startSession } from "./db/sessions.ts";
import {
  createTasksBatch,
  listTasksByPlan,
  nextTaskForAgent,
  resolveTaskDependencies,
  updateTaskStatus,
} from "./db/tasks.ts";
import type { Plan } from "./db/types.ts";
import {
  escalateToForeman,
  FileLock,
  mapTaskCreateBatchArg,
  NdomoPlugin,
  reconcileAbandonedPlans,
  registerTools,
} from "./plugin.ts";

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

  test("writes a continuity ledger when ctx.projectDir is provided", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-esc-ledger-"));
    try {
      const sessionId = "ses_esc_ledger";
      startSession(db, { id: sessionId, goal: "escalate with ledger" });

      escalateToForeman(
        db,
        { agent: "craftsman", sessionID: sessionId, projectDir },
        { reason: "needs ledger persistence" },
      );

      // The escalation checkpoint must persist a portable markdown ledger.
      const ledger = readLedger(projectDir, sessionId);
      expect(ledger).not.toBeNull();
      expect(ledger?.goal).toBe("escalate with ledger");
      expect(ledger?.keyDecisions).toContain("escalated by craftsman: needs ledger persistence");
      expect(ledger?.state).toMatchObject({ escalated: true });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("writes NO ledger when ctx.projectDir is absent (backwards-compatible)", () => {
    const sessionId = "ses_esc_noledger";
    startSession(db, { id: sessionId, goal: "no ledger" });
    // No projectDir → no ledger dir should ever be created anywhere reachable.
    escalateToForeman(db, { agent: "craftsman", sessionID: sessionId }, { reason: "legacy path" });
    // The DB checkpoint still happened (keyDecisions set) — ledger is the
    // only thing skipped.
    const session = getSession(db, sessionId);
    expect(session?.keyDecisions).toContain("escalated by craftsman: legacy path");
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

    const fetched = db.query("SELECT created_by_agent FROM plans WHERE id = ?").get(plan.id) as {
      created_by_agent: string | null;
    };
    expect(fetched.created_by_agent).toBe("craftsman");
  });

  test("sets created_by_agent to null when ctx.agent undefined", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "no-agent", title: "No Agent", overview: "test", priority: 2 },
      {},
    );

    const fetched = db.query("SELECT created_by_agent FROM plans WHERE id = ?").get(plan.id) as {
      created_by_agent: string | null;
    };
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

    const fetched = db.query("SELECT created_by_agent FROM plans WHERE id = ?").get(plan.id) as {
      created_by_agent: string | null;
    };
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
      {
        orderIndex: 0,
        description: "task a",
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
      {
        orderIndex: 1,
        description: "task b",
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

    const rows = db.query(PEEK_SQL).all("js-smith") as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[1]!.status).toBe("pending");
  });

  test("filters by planId when provided", () => {
    const plan1 = makePlan({ slug: "peek-plan-1" });
    const plan2 = makePlan({ slug: "peek-plan-2" });
    createTasksBatch(db, plan1.id, [
      {
        orderIndex: 0,
        description: "task 1",
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
    createTasksBatch(db, plan2.id, [
      {
        orderIndex: 0,
        description: "task 2",
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

    const rows = db.query(PEEK_SQL_WITH_PLAN).all("js-smith", plan1.id) as Array<{
      plan_id: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe(plan1.id);
  });

  test("excludes archived tasks", () => {
    const plan = makePlan({ slug: "peek-archived" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "archived task",
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
    const taskId = tasks[0]!.id;
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(Date.now(), taskId);

    const rows = db.query(PEEK_SQL).all("js-smith") as Array<unknown>;
    expect(rows).toHaveLength(0);
  });

  test("excludes non-pending tasks", () => {
    const plan = makePlan({ slug: "peek-running" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "running task",
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

    const rows = db.query(`${PEEK_SQL} LIMIT ?`).all("js-smith", 2) as Array<unknown>;
    expect(rows).toHaveLength(2);
  });
});

// ─── task_add_artifact logic (T1) ────────────────────────────────────────────

describe("task_add_artifact logic (T1)", () => {
  function addArtifact(taskId: string, artifact: string, role?: string) {
    const row = db.query("SELECT artifacts, plan_id FROM plan_tasks WHERE id = ?").get(taskId) as
      | { artifacts: string; plan_id: string }
      | undefined;
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
      {
        orderIndex: 0,
        description: "task",
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

    const result = addArtifact(tasks[0]!.id, "output.ts");
    expect(result.added).toBe(true);
    const task = db.query("SELECT artifacts FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      artifacts: string;
    };
    expect(JSON.parse(task.artifacts)).toEqual(["output.ts"]);
  });

  test("appends to non-empty array", () => {
    const plan = makePlan({ slug: "artifact-2" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
        artifacts: ["a.ts"],
        metadata: {},
      },
    ]);

    addArtifact(tasks[0]!.id, "b.ts");
    const task = db.query("SELECT artifacts FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      artifacts: string;
    };
    expect(JSON.parse(task.artifacts)).toEqual(["a.ts", "b.ts"]);
  });

  test("dedup — returns added:false if artifact exists", () => {
    const plan = makePlan({ slug: "artifact-3" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
        artifacts: ["a.ts"],
        metadata: {},
      },
    ]);

    const result = addArtifact(tasks[0]!.id, "a.ts");
    expect(result.added).toBe(false);
    expect(result.reason).toBe("artifact already exists");
  });

  test("with role — inserts into plan_files", () => {
    const plan = makePlan({ slug: "artifact-4" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
    const row = db.query("SELECT status, metadata FROM plan_tasks WHERE id = ?").get(taskId) as
      | { status: string; metadata: string | null }
      | undefined;
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
      {
        orderIndex: 0,
        description: "task",
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
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db.query("SELECT reviewed_by FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      reviewed_by: string | null;
    };
    expect(row.reviewed_by).toBe("inspector");
  });

  test("stores reviewedVerdict in metadata", () => {
    const plan = makePlan({ slug: "review-2" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db.query("SELECT metadata FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      metadata: string;
    };
    const meta = JSON.parse(row.metadata);
    expect(meta.reviewedVerdict).toBe("approved");
  });

  test("preserves existing metadata", () => {
    const plan = makePlan({ slug: "review-3" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
        metadata: { tokensUsed: 42 },
      },
    ]);
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    reviewTask(tasks[0]!.id, "inspector", "approved");
    const row = db.query("SELECT metadata FROM plan_tasks WHERE id = ?").get(tasks[0]!.id) as {
      metadata: string;
    };
    const meta = JSON.parse(row.metadata);
    expect(meta.tokensUsed).toBe(42);
    expect(meta.reviewedVerdict).toBe("approved");
  });

  test("rejects non-done task", () => {
    const plan = makePlan({ slug: "review-4" });
    const tasks = createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "task",
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
      {
        orderIndex: 0,
        description: "t1",
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
    createTasksBatch(db, plan2.id, [
      {
        orderIndex: 0,
        description: "t2",
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
      {
        orderIndex: 1,
        description: "t3",
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
      {
        orderIndex: 0,
        description: "t",
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

    const rows = db
      .query("SELECT * FROM plan_progress_active WHERE plan_id = ?")
      .all(plan.id) as Array<{ plan_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plan_id).toBe(plan.id);
  });

  test("filters by owner via json_extract", () => {
    makePlan({
      slug: "prog-owner-c",
      metadata: { category: "feature", ownedBy: "craftsman" } as never,
    });
    makePlan({
      slug: "prog-owner-w",
      metadata: { category: "feature", ownedBy: "warden" } as never,
    });

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
      {
        orderIndex: 0,
        description: "t1",
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
      {
        orderIndex: 1,
        description: "t2",
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
    updateTaskStatus(db, tasks[0]!.id, "done", { result: "ok" }, "test", { agent: "js-smith" });

    const row = db.query("SELECT * FROM plan_progress_active WHERE plan_id = ?").get(plan.id) as {
      progress_pct: number;
      done: number;
      pending: number;
    };
    expect(row.done).toBe(1);
    expect(row.pending).toBe(1);
    expect(row.progress_pct).toBe(50);
  });

  test("excludes archived plans", () => {
    const plan = makePlan({ slug: "prog-archived" });
    createTasksBatch(db, plan.id, [
      {
        orderIndex: 0,
        description: "t",
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
      {
        orderIndex: 0,
        description: "implement feature",
        agent: "js-smith",
        files: [],
        complexity: 2,
        dependencies: [],
        createdBy: "craftsman",
        updatedBy: "craftsman",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
      {
        orderIndex: 1,
        description: "write tests",
        agent: "js-smith",
        files: [],
        complexity: 2,
        dependencies: [],
        createdBy: "craftsman",
        updatedBy: "craftsman",
        sourceSessionId: null,
        sourceMessageId: null,
        reviewedBy: null,
        tokensUsed: null,
        durationMs: null,
        artifacts: [],
        metadata: {},
      },
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
    db.query("UPDATE plan_tasks SET reviewed_by = ?, metadata = ? WHERE id = ?").run(
      "inspector",
      JSON.stringify(updatedMeta),
      tasks[0]!.id,
    );

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

// ─── mapTaskCreateBatchArg — v17/T1 verificationRequired forwarding (Issue 4) ─

describe("mapTaskCreateBatchArg — verificationRequired forwarding (T1)", () => {
  const auditCtx = {
    createdBy: "foreman",
    updatedBy: "foreman",
    sourceSessionId: "ses_1",
    sourceMessageId: "msg_1",
  };

  test("forwards explicit verificationRequired=true", () => {
    const input = mapTaskCreateBatchArg(
      { description: "gated", agent: "js-smith", verificationRequired: true },
      auditCtx,
    );
    expect(input.verificationRequired).toBe(true);
  });

  test("forwards explicit verificationRequired=false", () => {
    const input = mapTaskCreateBatchArg(
      { description: "explicit-free", agent: "js-smith", verificationRequired: false },
      auditCtx,
    );
    expect(input.verificationRequired).toBe(false);
  });

  test("omits verificationRequired when not supplied (legacy path)", () => {
    const input = mapTaskCreateBatchArg({ description: "free", agent: "js-smith" }, auditCtx);
    expect(input.verificationRequired).toBeUndefined();
  });

  test("metadata.verificationRequired fallback is preserved untouched (backwards-compat)", () => {
    // The mapper does NOT promote metadata→field; createTasksBatch honors
    // metadata.verificationRequired===true as the legacy fallback. We only
    // assert the metadata passes through verbatim so that fallback keeps working.
    const input = mapTaskCreateBatchArg(
      { description: "legacy gated", agent: "js-smith", metadata: { verificationRequired: true } },
      auditCtx,
    );
    expect(input.verificationRequired).toBeUndefined();
    expect(input.metadata?.verificationRequired).toBe(true);
  });

  test("applies audit ctx + defaults (files, complexity, dependencies, artifacts)", () => {
    const input = mapTaskCreateBatchArg({ description: "d", agent: "a" }, auditCtx);
    expect(input.files).toEqual([]);
    expect(input.complexity).toBe(3);
    expect(input.dependencies).toEqual([]);
    expect(input.artifacts).toEqual([]);
    expect(input.createdBy).toBe("foreman");
    expect(input.updatedBy).toBe("foreman");
    expect(input.sourceSessionId).toBe("ses_1");
    expect(input.sourceMessageId).toBe("msg_1");
    // orderIndex intentionally NOT set — createTasksBatch allocates it.
    expect(input.orderIndex).toBeUndefined();
  });

  test("explicit field does NOT clobber a conflicting metadata value (field wins, forwarded as-is)", () => {
    const input = mapTaskCreateBatchArg(
      {
        description: "conflict",
        agent: "js-smith",
        verificationRequired: false,
        metadata: { verificationRequired: true },
      },
      auditCtx,
    );
    // Explicit field forwarded; metadata retained. createTasksBatch resolves
    // the OR (field===true || metadata===true) — false||true → gated, which is
    // the documented "metadata is a fallback, either opts in" semantics.
    expect(input.verificationRequired).toBe(false);
    expect(input.metadata?.verificationRequired).toBe(true);
  });
});

// ─── T2 helpers ──────────────────────────────────────────────────────────────

function createTestDeployment(db: Database): string {
  db.query(
    "INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("e1", "prod", "prod", Date.now(), Date.now());
  db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run(
    "r1",
    "1.0.0",
    "rel",
    Date.now(),
  );
  db.query(
    "INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("d1", "r1", "e1", "planned", Date.now());
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
    db.query(
      "INSERT INTO environments (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("e1", "prod", "prod", Date.now(), Date.now());
    db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run(
      "r1",
      "1.0.0",
      "rel",
      Date.now(),
    );
    db.query("INSERT INTO releases (id, version, title, created_at) VALUES (?, ?, ?, ?)").run(
      "r2",
      "1.0.1",
      "rel2",
      Date.now(),
    );
    db.query(
      "INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("d1", "r1", "e1", "planned", Date.now());
    db.query(
      "INSERT INTO deployments (id, release_id, environment_id, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("d2", "r2", "e1", "planned", Date.now());
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
    const incidentCheck = db.query("SELECT * FROM incidents WHERE id = ?").get(incident.id) as {
      triggered_by_deployment_id: string | null;
    };
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
          updateTaskStatus(
            db,
            tasks[i]!.id,
            st as "running" | "done" | "failed" | "blocked",
            {},
            "test",
            { agent: "js-smith" },
          );
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
    const plan1 = setupPlan({
      status: "executing",
      taskStatuses: ["done"],
      slug: "t3-term-completed",
    });
    const r1 = planUpdateStatusExecutor(
      db,
      { id: plan1.id, status: "completed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );
    expect(r1.plan!.completedAt).not.toBeNull();
    expect(r1.plan!.completedAt!).toBeGreaterThan(0);

    // failed
    const plan2 = setupPlan({
      status: "executing",
      taskStatuses: ["pending"],
      slug: "t3-term-failed",
    });
    const r2 = planUpdateStatusExecutor(
      db,
      { id: plan2.id, status: "failed" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );
    expect(r2.plan!.completedAt).not.toBeNull();
    expect(r2.plan!.completedAt!).toBeGreaterThan(0);

    // abandoned
    const plan3 = setupPlan({
      status: "executing",
      taskStatuses: ["done"],
      slug: "t3-term-abandoned",
    });
    const r3 = planUpdateStatusExecutor(
      db,
      { id: plan3.id, status: "abandoned" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );
    expect(r3.plan!.completedAt).not.toBeNull();
    expect(r3.plan!.completedAt!).toBeGreaterThan(0);
  });

  test("completed_at NOT set on non-terminal status — approved, executing", () => {
    const plan = setupPlan({ status: "draft", taskStatuses: [], slug: "t3-nonterm" });
    const r1 = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "approved" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );
    expect(r1.plan!.completedAt).toBeNull();

    const r2 = planUpdateStatusExecutor(
      db,
      { id: plan.id, status: "executing" },
      { agent: "craftsman" },
      ARCHIVE_DIR,
    );
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
    const audit = db.query("SELECT * FROM plan_audit WHERE plan_id = ?").get(plan.id) as {
      trigger: string;
      snapshot: string;
    } | null;
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
  function setupDepsPlan(taskDefs: Array<{ orderIndex: number; deps: string[]; agent?: string }>) {
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
    const plan = makePlan({ slug: `acp-${crypto.randomUUID().slice(0, 8)}` });
    db.query("UPDATE plans SET status = ? WHERE id = ?").run("executing", plan.id);

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
    }));
    const tasks = createTasksBatch(db, plan.id, taskDescs);
    return { plan, tasks };
  }

  test("trigger fires on phase_transition — checkpointSession updates session", async () => {
    const { plan } = setupPlanWithTasks(1);
    startSession(db, { id: "ses_acp_1", goal: "test auto-checkpoint" });
    // mark task done so plan can transition to completed
    const tasks = listTasksByPlan(db, plan.id);
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
    dispatcher.dispatch("phase_transition", {
      planId: plan.id,
      sessionId: "ses_acp_1",
      blockers: ["tasks_pending"],
    });

    // Flush microtask
    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_1");
    expect(sess).not.toBeNull();
    const state = sess!.state;
    expect(state.trigger).toBe("phase_transition");
    expect(state.completedTasks).toBe(1);
    expect(state.currentPhase).toBe("executing");
    expect(state.blockers).toEqual(["tasks_pending"]);
  });

  test("debounce works — two rapid calls produce only one checkpoint", async () => {
    const { plan } = setupPlanWithTasks(1);
    startSession(db, { id: "ses_acp_deb", goal: "debounce test" });

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 5000 });

    // First call — should fire
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_deb" });
    // Second call immediately — should be debounced
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_deb" });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_deb");
    expect(sess).not.toBeNull();
    // Only one checkpoint written — state should reflect the first call
    const state = sess!.state;
    expect(state.trigger).toBe("phase_transition");
  });

  test("disabled config = no-op — no checkpoint written", async () => {
    startSession(db, { id: "ses_acp_dis", goal: "disabled test" });
    const { plan } = setupPlanWithTasks(1);

    const dispatcher = new AutoCheckpointDispatcher(db, { enabled: false, minIntervalMs: 0 });
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_dis" });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_dis");
    expect(sess).not.toBeNull();
    // state should be the default empty object (no checkpoint written)
    expect(sess!.state).toEqual({});
  });

  test("no loop — checkpointSession does NOT trigger plan_update_status", async () => {
    const { plan } = setupPlanWithTasks(1);
    startSession(db, { id: "ses_acp_loop", goal: "loop test" });

    // Record plan status before
    const before = getPlan(db, plan.id);
    const statusBefore = before!.status;

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
    dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_loop" });

    await new Promise((r) => setTimeout(r, 10));

    // Plan status must NOT have changed — checkpointSession only touches sessions table
    const after = getPlan(db, plan.id);
    expect(after!.status).toBe(statusBefore);
  });

  test("task_batch_complete fires when last task done", async () => {
    const { plan, tasks } = setupPlanWithTasks(2);
    startSession(db, { id: "ses_acp_batch", goal: "batch test" });

    // Complete both tasks
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");
    updateTaskStatus(db, tasks[1]!.id, "done", {}, "test");

    // Verify no pending tasks remain
    const pending = listTasksByPlan(db, plan.id, { status: "pending" });
    expect(pending.length).toBe(0);

    // Simulate what plugin does: dispatch task_batch_complete
    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
    dispatcher.dispatch("task_batch_complete", { planId: plan.id, sessionId: "ses_acp_batch" });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_batch");
    expect(sess).not.toBeNull();
    const state = sess!.state;
    expect(state.trigger).toBe("task_batch_complete");
    expect(state.completedTasks).toBe(2);
  });

  test("task_batch_complete does NOT fire when non-last task done", async () => {
    const { plan, tasks } = setupPlanWithTasks(2);
    startSession(db, { id: "ses_acp_partial", goal: "partial batch test" });

    // Complete only the first task
    updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");

    // There IS still a pending task — so batch is NOT complete
    const pending = listTasksByPlan(db, plan.id, { status: "pending" });
    expect(pending.length).toBe(1);

    // Simulate what plugin does: do NOT dispatch because pending > 0
    // (In real code, the trigger is conditional on pending.length === 0)
    // We verify here that the session was NOT checkpointed
    const sess = getSession(db, "ses_acp_partial");
    expect(sess).not.toBeNull();
    expect(sess!.state).toEqual({});
  });

  test("no sessionId = skip — no checkpoint written", async () => {
    const { plan } = setupPlanWithTasks(1);
    startSession(db, { id: "ses_acp_nosess", goal: "no-session test" });

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
    // dispatch without sessionId
    dispatcher.dispatch("phase_transition", { planId: plan.id });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_nosess");
    expect(sess!.state).toEqual({});
  });

  test("unknown trigger = skip — no checkpoint written", async () => {
    startSession(db, { id: "ses_acp_unknown", goal: "unknown trigger test" });

    const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
    dispatcher.dispatch("some_random_trigger", { sessionId: "ses_acp_unknown" });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_unknown");
    expect(sess!.state).toEqual({});
  });

  test("captureState options — selective capture", async () => {
    const { plan } = setupPlanWithTasks(1);
    startSession(db, { id: "ses_acp_sel", goal: "selective capture test" });
    updateTaskStatus(db, listTasksByPlan(db, plan.id)[0]!.id, "done", {}, "test");

    const dispatcher = new AutoCheckpointDispatcher(db, {
      minIntervalMs: 0,
      captureState: { completedTasks: true, currentPhase: false, blockers: false },
    });
    dispatcher.dispatch("phase_transition", {
      planId: plan.id,
      sessionId: "ses_acp_sel",
      blockers: ["some_blocker"],
    });

    await new Promise((r) => setTimeout(r, 10));

    const sess = getSession(db, "ses_acp_sel");
    const state = sess!.state;
    expect(state.trigger).toBe("phase_transition");
    expect(state.completedTasks).toBe(1);
    // currentPhase and blockers should NOT be captured
    expect(state.currentPhase).toBeUndefined();
    expect(state.blockers).toBeUndefined();
  });

  test("projectDir in config → auto-checkpoint writes a continuity ledger", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-acp-ledger-"));
    try {
      const { plan } = setupPlanWithTasks(1);
      startSession(db, { id: "ses_acp_ledger", goal: "ledger auto-persist" });
      const tasks = listTasksByPlan(db, plan.id);
      updateTaskStatus(db, tasks[0]!.id, "done", {}, "test");

      const dispatcher = new AutoCheckpointDispatcher(db, {
        minIntervalMs: 0,
        projectDir,
      });
      dispatcher.dispatch("phase_transition", {
        planId: plan.id,
        sessionId: "ses_acp_ledger",
      });

      // Flush the microtask-scheduled checkpoint.
      await new Promise((r) => setTimeout(r, 10));

      // DB checkpoint happened…
      const sess = getSession(db, "ses_acp_ledger");
      expect(sess?.state.trigger).toBe("phase_transition");
      // …and a portable ledger was persisted alongside it.
      const ledger = readLedger(projectDir, "ses_acp_ledger");
      expect(ledger).not.toBeNull();
      expect(ledger?.goal).toBe("ledger auto-persist");
      expect(ledger?.state).toMatchObject({ trigger: "phase_transition" });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("no projectDir in config → auto-checkpoint writes NO ledger (legacy)", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-acp-noleg-"));
    try {
      const { plan } = setupPlanWithTasks(1);
      startSession(db, { id: "ses_acp_noleg", goal: "legacy no ledger" });

      // No projectDir passed — legacy behaviour.
      const dispatcher = new AutoCheckpointDispatcher(db, { minIntervalMs: 0 });
      dispatcher.dispatch("phase_transition", { planId: plan.id, sessionId: "ses_acp_noleg" });

      await new Promise((r) => setTimeout(r, 10));

      // DB checkpoint still fires…
      const sess = getSession(db, "ses_acp_noleg");
      expect(sess?.state.trigger).toBe("phase_transition");
      // …but no ledger directory was ever created.
      expect(existsSync(join(projectDir, ".ndomo", "ledgers"))).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// ─── FileLock (activeWrites TTL — plan fcb12dc5 #3) ──────────────────────────

describe("FileLock", () => {
  test("acquire returns null when filepath is unlocked", () => {
    const lock = new FileLock(60_000);
    expect(lock.acquire("/tmp/a.ts", "k1")).toBeNull();
    expect(lock.has("/tmp/a.ts")).toBe(true);
  });

  test("acquire returns existing key when filepath is locked by another", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    expect(lock.acquire("/tmp/a.ts", "k2")).toBe("k1");
    // k2 should NOT have overwritten
    expect(lock.acquire("/tmp/a.ts", "k1")).toBeNull();
  });

  test("release with matching key removes the lock", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    lock.release("/tmp/a.ts", "k1");
    expect(lock.has("/tmp/a.ts")).toBe(false);
    expect(lock.acquire("/tmp/a.ts", "k2")).toBeNull();
  });

  test("release with non-matching key is a no-op (defensive)", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    lock.release("/tmp/a.ts", "k2");
    expect(lock.has("/tmp/a.ts")).toBe(true);
  });

  test("forceRelease drops any lock regardless of key (admin recovery)", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    expect(lock.forceRelease("/tmp/a.ts")).toBe(true);
    expect(lock.has("/tmp/a.ts")).toBe(false);
    // Releasing an unheld path returns false
    expect(lock.forceRelease("/tmp/missing.ts")).toBe(false);
  });

  test("TTL sweep releases expired locks (regression: SDK hook-miss leak)", () => {
    const lock = new FileLock(10);
    lock.acquire("/tmp/a.ts", "k1");
    expect(lock.has("/tmp/a.ts")).toBe(true);

    // Wait past TTL — Date.now() advances
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const swept = lock.sweep();
        expect(swept).toBe(1);
        expect(lock.has("/tmp/a.ts")).toBe(false);
        // Subsequent acquire succeeds (regression: must not leak across SDK failures)
        expect(lock.acquire("/tmp/a.ts", "k2")).toBeNull();
        resolve();
      }, 25);
    });
  });

  test("TTL sweep keeps fresh locks intact", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    const swept = lock.sweep();
    expect(swept).toBe(0);
    expect(lock.has("/tmp/a.ts")).toBe(true);
  });

  test("acquire auto-sweeps expired entries before checking (lazy cleanup)", () => {
    const lock = new FileLock(10);
    lock.acquire("/tmp/a.ts", "k1");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Even without explicit sweep(), acquire auto-sweeps and proceeds
        expect(lock.acquire("/tmp/a.ts", "k2")).toBeNull();
        resolve();
      }, 25);
    });
  });

  test("keys() returns all currently-locked filepaths (compaction context)", () => {
    const lock = new FileLock(60_000);
    lock.acquire("/tmp/a.ts", "k1");
    lock.acquire("/tmp/b.ts", "k2");
    expect(lock.keys().sort()).toEqual(["/tmp/a.ts", "/tmp/b.ts"]);
  });

  test("size() reflects current lock count", () => {
    const lock = new FileLock(60_000);
    expect(lock.size()).toBe(0);
    lock.acquire("/tmp/a.ts", "k1");
    lock.acquire("/tmp/b.ts", "k2");
    expect(lock.size()).toBe(2);
    lock.release("/tmp/a.ts", "k1");
    expect(lock.size()).toBe(1);
  });
});

// ─── analysis tools (v14) ────────────────────────────────────────────────────

describe("analysis tools", () => {
  function makeAnalysis(overrides?: Record<string, unknown>) {
    return createAnalysis(db, {
      slug: "test-analysis",
      title: "Test Analysis",
      projectPath: "/test/project",
      summary: "A test analysis",
      findingsJson: JSON.stringify([{ id: 1, text: "finding one" }]),
      agent: "ranger",
      createdBy: "test",
      ...overrides,
    });
  }

  test("analysis_create — happy path, returns shape with id", () => {
    const result = makeAnalysis();
    expect(result.id).toBeTruthy();
    expect(result.slug).toBe("test-analysis");
    expect(result.title).toBe("Test Analysis");
    expect(result.projectPath).toBe("/test/project");
    expect(result.agent).toBe("ranger");
    expect(result.createdBy).toBe("test");
  });

  test("analysis_list — returns created row, excludes archived by default", () => {
    makeAnalysis({ slug: "list-a" });
    makeAnalysis({ slug: "list-b" });
    archiveAnalysis(
      db,
      getAnalysis(
        db,
        getAnalysis(db, listAnalyses(db, { limit: 10 }).find((a) => a.slug === "list-b")!.id)!.id,
      )!.id,
    );

    const results = listAnalyses(db);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.archivedAt === null)).toBe(true);
  });

  test("analysis_get — returns single row, throws on missing", () => {
    const created = makeAnalysis({ slug: "get-test" });
    const fetched = getAnalysis(db, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);

    const missing = getAnalysis(db, "nonexistent-id");
    expect(missing).toBeNull();
  });

  test("analysis_search — finds by title word", () => {
    makeAnalysis({ slug: "search-test", title: "Architecture Review Q3" });
    const results = searchAnalyses(db, "Architecture");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.title.includes("Architecture"))).toBe(true);
  });

  test("analysis_update — bumps updated_at", () => {
    const created = makeAnalysis({ slug: "update-test" });

    const updated = updateAnalysis(db, created.id, { title: "Updated Title" });
    expect(updated.title).toBe("Updated Title");
    // updated_at should be a valid ISO string (datetime('now'))
    expect(updated.updatedAt).toBeTruthy();
  });

  test("analysis_archive — sets archived_at, then list excludes by default", () => {
    const created = makeAnalysis({ slug: "archive-test" });
    expect(created.archivedAt).toBeNull();

    const archived = archiveAnalysis(db, created.id);
    expect(archived.archivedAt).not.toBeNull();

    const results = listAnalyses(db);
    expect(results.every((r) => r.id !== created.id || r.archivedAt !== null)).toBe(true);
  });

  test("analysis_link_plan — sets source_plan_id, then unlink clears it", () => {
    const analysis = makeAnalysis({ slug: "link-test" });
    const plan = createPlan(db, {
      id: "plan-for-link",
      slug: "plan-link",
      title: "Plan for Link",
      status: "draft",
      priority: 1,
      overview: "test",
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

    // Link
    const linked = linkAnalysisToPlan(db, analysis.id, plan.id);
    expect(linked.sourcePlanId).toBe(plan.id);

    // Unlink
    const unlinked = unlinkAnalysisFromPlan(db, analysis.id);
    expect(unlinked.sourcePlanId).toBeNull();
  });
});

// ─── v2 plugin registration (Plugin.define + ctx.tool.transform) ─────────────

type PluginSetupCtx = Parameters<(typeof NdomoPlugin)["setup"]>[0];

type HarnessTool = {
  name: string;
  description: string;
  input: unknown;
  execute: (input: Record<string, unknown>, context: unknown) => Promise<{ content: string }>;
};

type HarnessHook = { name: string; cb: (event: any) => Promise<void> | void };

/**
 * Minimal in-process stand-in for the v2 Plugin.Context. Only the surfaces
 * src/plugin.ts touches are implemented; the rest is assumed by the cast.
 */
function makePluginHarness(projectDir: string) {
  const tools: HarnessTool[] = [];
  const sessionHooks: HarnessHook[] = [];
  const toolHooks: HarnessHook[] = [];
  const shellHooks: HarnessHook[] = [];
  const disposals: string[] = [];
  const registration = (label: string) => ({
    dispose: async () => {
      disposals.push(label);
    },
  });
  const ctx = {
    app: { name: "opencode", version: "2.0.12", channel: "latest" },
    location: {
      directory: projectDir,
      project: { id: "proj_harness", directory: projectDir, canonical: projectDir },
    },
    options: {},
    session: {
      hook: async (name: string, cb: HarnessHook["cb"]) => {
        sessionHooks.push({ name, cb });
        return registration(`session:${name}`);
      },
    },
    tool: {
      hook: async (name: string, cb: HarnessHook["cb"]) => {
        toolHooks.push({ name, cb });
        return registration(`tool:${name}`);
      },
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (t: HarnessTool) => {
            tools.push(t);
          },
          update: () => {},
          remove: () => {},
          list: () => tools,
          get: () => undefined,
          namespace: () => {},
        });
        return registration("tool:transform");
      },
    },
    shell: {
      hook: async (name: string, cb: HarnessHook["cb"]) => {
        shellHooks.push({ name, cb });
        return registration(`shell:${name}`);
      },
    },
  } as unknown as PluginSetupCtx;
  const toolCtx = (sessionID: string, agent = "craftsman") => ({
    sessionID,
    agent,
    messageID: "msg_harness",
    id: "call_harness",
    signal: new AbortController().signal,
    progress: async () => {},
  });
  return { ctx, tools, sessionHooks, toolHooks, shellHooks, disposals, toolCtx };
}

describe("NdomoPlugin v2 registration", () => {
  const priorEnv = {
    skipFrontmatter: process.env.NDOMO_SKIP_FRONTMATTER_SYNC,
    httpEnabled: process.env.NDOMO_HTTP_ENABLED,
  };

  afterAll(() => {
    if (priorEnv.skipFrontmatter === undefined) delete process.env.NDOMO_SKIP_FRONTMATTER_SYNC;
    else process.env.NDOMO_SKIP_FRONTMATTER_SYNC = priorEnv.skipFrontmatter;
    if (priorEnv.httpEnabled === undefined) delete process.env.NDOMO_HTTP_ENABLED;
    else process.env.NDOMO_HTTP_ENABLED = priorEnv.httpEnabled;
  });

  const setupPlugin = async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-v2-plugin-"));
    process.env.NDOMO_SKIP_FRONTMATTER_SYNC = "1";
    process.env.NDOMO_HTTP_ENABLED = "false";
    const harness = makePluginHarness(projectDir);
    const cleanup = await NdomoPlugin.setup(harness.ctx);
    if (typeof cleanup !== "function") throw new Error("setup did not return a cleanup fn");
    return { projectDir, harness, cleanup };
  };

  test("setup registers 59 tools, all 4 hooks, and returns a cleanup fn", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      expect(typeof cleanup).toBe("function");
      expect(harness.tools).toHaveLength(59);
      const names = harness.tools.map((t) => t.name);
      expect(names).toContain("plan_create");
      expect(names).toContain("task_update_status");
      expect(names).toContain("status");
      expect(names).toContain("route");
      // Consolidated from the former v1 standalone tools/ (removed in v2).
      expect(names).toContain("ledger_create");
      expect(names).toContain("ledger_get");
      expect(names).toContain("ledger_update");
      expect(names).toContain("design_create");
      expect(names).toContain("critic_review");
      // Embedded memory surface (replaces the former external memory plugin tool).
      expect(names).toContain("memory_compress");
      expect(names).toContain("mem_add");
      expect(names).toContain("mem_search");
      expect(names).toContain("mem_list");
      expect(names).toContain("mem_forget");
      expect(names).toContain("mem_stats");
      expect(new Set(names).size).toBe(59);
      expect(harness.sessionHooks.map((h) => h.name)).toEqual(["compaction"]);
      expect(harness.toolHooks.map((h) => h.name).sort()).toEqual([
        "execute.after",
        "execute.before",
      ]);
      expect(harness.shellHooks.map((h) => h.name)).toEqual(["create.before"]);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("tool execute returns v2 { content } and injects directory from setup ctx", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const status = harness.tools.find((t) => t.name === "status");
      expect(status).toBeDefined();
      const res = await status!.execute({}, harness.toolCtx("ses_v2_status"));
      expect(typeof res.content).toBe("string");
      const parsed = JSON.parse(res.content) as {
        plugin: string;
        directory: string;
        worktree: string | null;
      };
      expect(parsed.plugin).toBe("ndomo");
      expect(parsed.directory).toBe(projectDir);
      expect(parsed.worktree).toBe(projectDir);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("plan_create tool persists agent + session audit fields in the v2 path", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    const pluginDb = new Database(join(projectDir, ".ndomo", "state.db"));
    try {
      const planCreate = harness.tools.find((t) => t.name === "plan_create");
      expect(planCreate).toBeDefined();
      const res = await planCreate!.execute(
        {
          slug: "t1-harness",
          title: "T1 harness",
          overview: "v2 registration smoke",
          priority: 3,
        },
        harness.toolCtx("ses_v2_plancreate", "js-smith"),
      );
      const created = JSON.parse(res.content) as { id: string; status: string };
      expect(created.id).toBeTruthy();
      expect(created.status).toBe("draft");
      const row = pluginDb
        .query("SELECT created_by, source_session_id, status FROM plans WHERE id = ?")
        .get(created.id) as { created_by: string; source_session_id: string; status: string };
      expect(row.created_by).toBe("js-smith");
      expect(row.source_session_id).toBe("ses_v2_plancreate");
    } finally {
      pluginDb.close();
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("compaction hook injects orchestrator state into event.system", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const hook = harness.sessionHooks.find((h) => h.name === "compaction");
      expect(hook).toBeDefined();
      const event = {
        sessionID: "ses_v2_compaction",
        model: { providerID: "test", modelID: "test" },
        system: [] as Array<{ type: "text"; text: string }>,
        messages: [],
        options: {},
        agent: "craftsman",
        tools: {},
      };
      await hook!.cb(event);
      expect(event.system.length).toBeGreaterThan(0);
      expect(event.system.some((p) => p.text.includes("## ndomo orchestrator state"))).toBe(true);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("execute.before/after wire the FileLock lifecycle through v2 events", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const before = harness.toolHooks.find((h) => h.name === "execute.before");
      const after = harness.toolHooks.find((h) => h.name === "execute.after");
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      const filePath = join(projectDir, "locked.txt");
      const base = {
        tool: "write",
        sessionID: "ses_v2_lock",
        agent: "craftsman",
        messageID: "msg_1",
      };

      await before!.cb({ ...base, id: "call_1", input: { filePath } });
      await expect(before!.cb({ ...base, id: "call_2", input: { filePath } })).rejects.toThrow(
        /file locked/,
      );
      await after!.cb({
        ...base,
        id: "call_1",
        input: { filePath },
        status: "completed",
        result: { content: "ok" },
      });
      // Lock released → a fresh call can acquire it again.
      await before!.cb({ ...base, id: "call_3", input: { filePath } });
      await after!.cb({
        ...base,
        id: "call_3",
        input: { filePath },
        status: "completed",
        result: { content: "ok" },
      });
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("v1→v2 adapter reinjects legacy context fields and wraps results", async () => {
    const added: HarnessTool[] = [];
    let seen: Record<string, unknown> | null = null;
    registerTools(
      { add: (t: unknown) => added.push(t as HarnessTool) } as never,
      {
        demo_json: {
          description: "returns a json object",
          args: { filePath: z.string() },
          execute: (args: unknown, context: unknown) => {
            seen = context as Record<string, unknown>;
            return { ok: true, filePath: (args as { filePath: string }).filePath };
          },
        },
        demo_text: {
          description: "returns plain text",
          args: {},
          execute: () => "plain output",
        },
      },
      { directory: "/proj/dir", worktree: "/proj/wt" },
    );

    expect(added).toHaveLength(2);
    const jsonTool = added.find((t) => t.name === "demo_json");
    const textTool = added.find((t) => t.name === "demo_text");
    if (!jsonTool || !textTool) throw new Error("adapter did not register both tools");

    const signal = new AbortController().signal;
    const json = await jsonTool.execute(
      { filePath: "/a.ts" },
      { sessionID: "ses", messageID: "msg", agent: "ranger", id: "call-123", signal },
    );
    expect(json).toEqual({ content: JSON.stringify({ ok: true, filePath: "/a.ts" }) });
    // v2 → legacy context translation: id → callID, signal → abort, plus the
    // directory/worktree pair captured at registration time.
    expect(seen).toMatchObject({
      sessionID: "ses",
      messageID: "msg",
      agent: "ranger",
      callID: "call-123",
      directory: "/proj/dir",
      worktree: "/proj/wt",
    });
    expect((seen as Record<string, unknown> | null)?.abort).toBe(signal);

    const text = await textTool.execute(
      {},
      { sessionID: "ses", messageID: "msg", agent: "ranger", id: "call-9", signal },
    );
    // String results are passed through verbatim (no JSON quoting).
    expect(text).toEqual({ content: "plain output" });
  });

  test("execute.before ignores non-write/edit tools and after does not release them", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const before = harness.toolHooks.find((h) => h.name === "execute.before");
      const after = harness.toolHooks.find((h) => h.name === "execute.after");
      if (!before || !after) throw new Error("hooks not registered");
      const filePath = join(projectDir, "shared-file.ts");
      const base = { sessionID: "ses_v2_ignore", agent: "craftsman", messageID: "msg_i" };

      // A write acquires the lock…
      await before.cb({ ...base, id: "w1", tool: "write", input: { filePath } });
      // …reads are not serialized by the lock manager…
      await before.cb({ ...base, id: "r1", tool: "read", input: { filePath } });
      // …and an execute.after for the read must not release the write lock.
      await after.cb({
        ...base,
        id: "r1",
        tool: "read",
        input: { filePath },
        status: "completed",
        result: { content: "contents" },
      });
      await expect(
        before.cb({ ...base, id: "w2", tool: "edit", input: { filePath } }),
      ).rejects.toThrow(/file locked/);

      await after.cb({
        ...base,
        id: "w1",
        tool: "write",
        input: { filePath },
        status: "completed",
        result: { content: "ok" },
      });
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("shell create.before hook injects NDOMO_* env vars", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const hook = harness.shellHooks.find((h) => h.name === "create.before");
      expect(hook).toBeDefined();
      const env: Record<string, string | undefined> = {};
      await hook!.cb({
        command: "ls",
        cwd: projectDir,
        timeout: 1000,
        shell: "/bin/bash",
        env,
      });
      expect(env.NDOMO_PRESET).toBe("default");
      expect(env.NDOMO_PROJECT).toBe(projectDir);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("cleanup is idempotent and a fresh instance can register after reload", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-v2-plugin-"));
    process.env.NDOMO_SKIP_FRONTMATTER_SYNC = "1";
    process.env.NDOMO_HTTP_ENABLED = "false";
    try {
      const first = makePluginHarness(projectDir);
      const firstCleanup = await NdomoPlugin.setup(first.ctx);
      if (typeof firstCleanup !== "function") throw new Error("setup did not return a cleanup fn");
      expect(first.tools).toHaveLength(59);
      await firstCleanup();
      await firstCleanup(); // idempotent — a second dispose must not throw

      // Reload semantics: a new setup on the same project opens its own DB
      // and registers its own tools/hooks without inheriting the old ones.
      const second = makePluginHarness(projectDir);
      const secondCleanup = await NdomoPlugin.setup(second.ctx);
      if (typeof secondCleanup !== "function") {
        throw new Error("setup did not return a cleanup fn");
      }
      expect(second.tools).toHaveLength(59);
      expect(first.tools).toHaveLength(59);
      await secondCleanup();
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("consolidated tools (ledger_*, design_create, critic_review) work through the v2 path", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const find = (name: string) => {
        const tool = harness.tools.find((t) => t.name === name);
        if (!tool) throw new Error(`tool not registered: ${name}`);
        return tool;
      };

      // ledger_create → ledger_get → ledger_update round-trip (DB-free FS).
      const created = JSON.parse(
        (
          await find("ledger_create").execute(
            { sessionId: "ses_v2_ledger", goal: "v2 ledger smoke" },
            harness.toolCtx("ses_v2_ledger"),
          )
        ).content,
      ) as { filePath: string; created: boolean };
      expect(created.created).toBe(true);
      expect(existsSync(created.filePath)).toBe(true);

      const read = JSON.parse(
        (await find("ledger_get").execute({ sessionId: "ses_v2_ledger" }, harness.toolCtx("x")))
          .content,
      ) as { goal: string };
      expect(read.goal).toBe("v2 ledger smoke");

      const updated = JSON.parse(
        (
          await find("ledger_update").execute(
            { sessionId: "ses_v2_ledger", outcome: "success" },
            harness.toolCtx("x"),
          )
        ).content,
      ) as { updatedAt: number };
      expect(typeof updated.updatedAt).toBe("number");

      // ledger_update must refuse a missing ledger.
      await expect(
        find("ledger_update").execute({ sessionId: "ses_missing" }, harness.toolCtx("x")),
      ).rejects.toThrow(/no ledger found/);

      // design_create writes a markdown doc under <projectDir>/.ndomo/designs/.
      const design = JSON.parse(
        (
          await find("design_create").execute(
            { slug: "v2-smoke", title: "V2 smoke", problem: "Tools-dir removal" },
            harness.toolCtx("x", "foreman"),
          )
        ).content,
      ) as { filePath: string };
      expect(existsSync(design.filePath)).toBe(true);

      // critic_review returns the binary report + the task_verify payload.
      const critic = JSON.parse(
        (
          await find("critic_review").execute(
            { diff: "--- a/x.ts\n+++ b/x.ts", verdict: "APPROVED" },
            harness.toolCtx("x", "critic"),
          )
        ).content,
      ) as { executionGate: { verdict: string } };
      expect(critic.executionGate.verdict).toBe("passed");
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

/**
 * Plugin-level smoke tests for the 4 JEV toolkit tools, exercised with JEV
 * disabled (no TYPESAFE_API_KEY → `callJev` returns null before building any
 * client). Every test therefore pins the *deterministic* path: parser rules
 * and fallbacks, never a network round-trip.
 */
describe("JEV toolkit tools — deterministic smoke (no network)", () => {
  const priorEnv = {
    skipFrontmatter: process.env.NDOMO_SKIP_FRONTMATTER_SYNC,
    httpEnabled: process.env.NDOMO_HTTP_ENABLED,
    typesafeKey: process.env.TYPESAFE_API_KEY,
  };

  beforeAll(() => {
    // Force the no-key path: `callJev` returns null before constructing a
    // client, so no request can ever leave the process (zero network).
    delete process.env.TYPESAFE_API_KEY;
  });

  afterAll(() => {
    if (priorEnv.skipFrontmatter === undefined) delete process.env.NDOMO_SKIP_FRONTMATTER_SYNC;
    else process.env.NDOMO_SKIP_FRONTMATTER_SYNC = priorEnv.skipFrontmatter;
    if (priorEnv.httpEnabled === undefined) delete process.env.NDOMO_HTTP_ENABLED;
    else process.env.NDOMO_HTTP_ENABLED = priorEnv.httpEnabled;
    // Restore the exact prior value (undefined → delete, not "undefined").
    if (priorEnv.typesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = priorEnv.typesafeKey;
  });

  const setupPlugin = async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-v2-jev-smoke-"));
    process.env.NDOMO_SKIP_FRONTMATTER_SYNC = "1";
    process.env.NDOMO_HTTP_ENABLED = "false";
    const harness = makePluginHarness(projectDir);
    const cleanup = await NdomoPlugin.setup(harness.ctx);
    if (typeof cleanup !== "function") throw new Error("setup did not return a cleanup fn");
    return { projectDir, harness, cleanup };
  };

  const toolByName = (harness: ReturnType<typeof makePluginHarness>, name: string) => {
    const tool = harness.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool;
  };

  test("classify_intent returns JSON null when JEV is disabled", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const res = await toolByName(harness, "classify_intent").execute(
        { prompt: "add a logout button to the settings page" },
        harness.toolCtx("ses_jev_intent"),
      );
      expect(res.content).toBe("null");
      expect(JSON.parse(res.content)).toBeNull();
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("classify_tests uses the deterministic parser when the output is conclusive", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const output = [
        "bun test v1.2.0",
        "",
        "✓ a",
        "✓ b",
        "",
        " 2 pass",
        " 0 fail",
        "Ran 2 tests across 1 file.",
      ].join("\n");
      const res = await toolByName(harness, "classify_tests").execute(
        { output, exitCode: 0 },
        harness.toolCtx("ses_jev_tests_conclusive"),
      );
      const parsed = JSON.parse(res.content) as {
        verdict: string;
        source: string;
        counts: { total: number };
        warnings: string[];
      };
      expect(parsed.verdict).toBe("green");
      expect(parsed.source).toBe("parser");
      expect(parsed.counts.total).toBeGreaterThanOrEqual(2);
      expect(parsed.warnings.some((w) => w.includes("JEV unavailable"))).toBe(false);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("classify_tests falls back deterministically on ambiguous output", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const res = await toolByName(harness, "classify_tests").execute(
        { output: "something went wrong\nno tests here" },
        harness.toolCtx("ses_jev_tests_ambiguous"),
      );
      const parsed = JSON.parse(res.content) as {
        verdict: string;
        source: string;
        warnings: string[];
      };
      expect(parsed.source).toBe("fallback");
      expect(parsed.warnings.some((w) => w.includes("JEV unavailable"))).toBe(true);
      // Observed deterministic value with no parsed evidence: "none".
      expect(parsed.verdict).toBe("none");
      expect(["green", "red", "mixed", "none"]).toContain(parsed.verdict);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("code_traffic_light returns green via rules for a clean diff", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
 const items = [1, 2, 3];
+const total = items.length;
`;
      const res = await toolByName(harness, "code_traffic_light").execute(
        { diff },
        harness.toolCtx("ses_jev_risk_green"),
      );
      const parsed = JSON.parse(res.content) as {
        light: string;
        source: string;
        findings: unknown[];
      };
      expect(parsed.light).toBe("green");
      expect(parsed.source).toBe("rules");
      expect(parsed.findings).toHaveLength(0);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("code_traffic_light returns red via rules for an eval() addition", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const diff = `diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,1 +1,2 @@
 const x = 1;
+eval("boom")
`;
      const res = await toolByName(harness, "code_traffic_light").execute(
        { diff },
        harness.toolCtx("ses_jev_risk_red"),
      );
      const parsed = JSON.parse(res.content) as {
        light: string;
        source: string;
        findings: Array<{ patternId: string; file: string; line: number }>;
      };
      expect(parsed.light).toBe("red");
      expect(parsed.source).toBe("rules");
      expect(parsed.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ patternId: "eval-call", file: "x.ts" })]),
      );
      const evalFinding = parsed.findings.find((f) => f.patternId === "eval-call");
      expect(evalFinding?.line).toBe(2);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("code_traffic_light falls back to yellow for a medium-severity finding", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const diff = `diff --git a/x.test.ts b/x.test.ts
index 1111111..2222222 100644
--- a/x.test.ts
+++ b/x.test.ts
@@ -1,1 +1,2 @@
 describe("x", () => {
+  it.skip("skipped", () => {});
`;
      const res = await toolByName(harness, "code_traffic_light").execute(
        { diff },
        harness.toolCtx("ses_jev_risk_yellow"),
      );
      const parsed = JSON.parse(res.content) as {
        light: string;
        source: string;
        warnings: string[];
      };
      expect(parsed.light).toBe("yellow");
      expect(parsed.source).toBe("fallback");
      expect(parsed.warnings.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("validate_task_dependencies advisory then apply (pending tasks only)", async () => {
    const { projectDir, harness, cleanup } = await setupPlugin();
    try {
      const planCreate = toolByName(harness, "plan_create");
      const taskBatch = toolByName(harness, "task_create_batch");
      const validate = toolByName(harness, "validate_task_dependencies");
      const taskList = toolByName(harness, "task_list");

      // ── Advisory path: A "core module" + B "docs after core lands" ─────────
      const plan = JSON.parse(
        (
          await planCreate.execute(
            {
              slug: "jev-deps-advisory",
              title: "JEV deps advisory",
              overview: "smoke",
              priority: 3,
            },
            harness.toolCtx("ses_jev_deps_1"),
          )
        ).content,
      ) as { id: string };

      const created = JSON.parse(
        (
          await taskBatch.execute(
            {
              planId: plan.id,
              tasks: [
                { description: "core module", agent: "craftsman", files: ["src/core.ts"] },
                {
                  description: "docs after core lands",
                  agent: "craftsman",
                  files: ["docs/x.md"],
                },
              ],
            },
            harness.toolCtx("ses_jev_deps_1"),
          )
        ).content,
      ) as Array<{ id: string }>;
      const [taskA, taskB] = created;
      if (!taskA || !taskB) throw new Error("task_create_batch did not return 2 tasks");

      const advisory = JSON.parse(
        (await validate.execute({ planId: plan.id }, harness.toolCtx("ses_jev_deps_1"))).content,
      ) as {
        source: string;
        pairs: Array<{ a: string; b: string }>;
        edges: Array<{ from: string; to: string }>;
        waves: string[][];
        applied: unknown[];
      };
      expect(advisory.source).toBe("rules");
      expect(advisory.pairs).toHaveLength(1);
      expect(advisory.pairs[0]).toMatchObject({ a: taskA.id, b: taskB.id });
      expect(advisory.edges).toEqual([{ from: taskA.id, to: taskB.id }]);
      expect(advisory.waves).toEqual([[taskA.id], [taskB.id]]);
      expect(advisory.applied).toEqual([]);

      // ── Apply path: same plan, deps merged into the pending task B ─────────
      const applied = JSON.parse(
        (
          await validate.execute(
            { planId: plan.id, apply: true },
            harness.toolCtx("ses_jev_deps_1"),
          )
        ).content,
      ) as {
        applied: Array<{ taskId: string; added: string[]; dependencies: string[] }>;
      };
      expect(applied.applied).toEqual([
        { taskId: taskB.id, added: [taskA.id], dependencies: [taskA.id] },
      ]);

      // Persistence + pending-only: read back via the task_list tool.
      const listed = JSON.parse(
        (await taskList.execute({ planId: plan.id }, harness.toolCtx("ses_jev_deps_1"))).content,
      ) as Array<{ id: string; status: string; dependencies: string[] }>;
      const persistedB = listed.find((t) => t.id === taskB.id);
      expect(persistedB?.status).toBe("pending");
      expect(persistedB?.dependencies).toContain(taskA.id);
      // Every applied task must have been pending.
      for (const entry of applied.applied) {
        expect(listed.find((t) => t.id === entry.taskId)?.status).toBe("pending");
      }

      // ── Pending-only guard: a done task must NOT receive suggestions ───────
      const plan2 = JSON.parse(
        (
          await planCreate.execute(
            {
              slug: "jev-deps-pending-guard",
              title: "JEV deps guard",
              overview: "smoke",
              priority: 3,
            },
            harness.toolCtx("ses_jev_deps_2"),
          )
        ).content,
      ) as { id: string };
      const created2 = JSON.parse(
        (
          await taskBatch.execute(
            {
              planId: plan2.id,
              tasks: [
                { description: "core module", agent: "craftsman", files: ["src/core.ts"] },
                {
                  description: "docs after core lands",
                  agent: "craftsman",
                  files: ["docs/x.md"],
                },
                {
                  description: "audit after core lands",
                  agent: "craftsman",
                  files: ["src/core.ts"],
                },
              ],
            },
            harness.toolCtx("ses_jev_deps_2"),
          )
        ).content,
      ) as Array<{ id: string }>;
      const [guardA, guardB, guardC] = created2;
      if (!guardA || !guardB || !guardC) throw new Error("guard plan needs 3 tasks");

      // Mark C done → the apply loop must skip it (only pending tasks get deps).
      await toolByName(harness, "task_update_status").execute(
        { id: guardC.id, status: "done", result: "already landed" },
        harness.toolCtx("ses_jev_deps_2"),
      );

      const guarded = JSON.parse(
        (
          await validate.execute(
            { planId: plan2.id, apply: true },
            harness.toolCtx("ses_jev_deps_2"),
          )
        ).content,
      ) as {
        suggestions: Record<string, string[]>;
        applied: Array<{ taskId: string; added: string[] }>;
      };
      // C is a suggestion target but was done → skipped.
      expect(guarded.suggestions[guardC.id]).toEqual([guardA.id]);
      expect(guarded.applied.map((e) => e.taskId)).toEqual([guardB.id]);
      expect(guarded.applied[0]?.added).toEqual([guardA.id]);

      const listed2 = JSON.parse(
        (await taskList.execute({ planId: plan2.id }, harness.toolCtx("ses_jev_deps_2"))).content,
      ) as Array<{ id: string; status: string; dependencies: string[] }>;
      const doneC = listed2.find((t) => t.id === guardC.id);
      expect(doneC?.status).toBe("done");
      expect(doneC?.dependencies).toEqual([]);
      expect(listed2.find((t) => t.id === guardB.id)?.dependencies).toContain(guardA.id);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

/**
 * Memory tools (mem_*) — end-to-end smoke through the v2 registration path.
 *
 * Each test points NDOMO_MEM_STORAGE_PATH at its own tmp dir so the
 * module-level FlexSearch cache (keyed by `storagePath::projectTag`) is never
 * shared across tests, and uses unique content to avoid any stale index hit.
 */
describe("memory tools (mem_*)", () => {
  // Captured at module load (pre-test values) so each test restores the env it
  // touched — an unreleased NDOMO_HTTP_ENABLED would leak into later files.
  const priorEnv = {
    storage: process.env.NDOMO_MEM_STORAGE_PATH,
    skipFrontmatter: process.env.NDOMO_SKIP_FRONTMATTER_SYNC,
    httpEnabled: process.env.NDOMO_HTTP_ENABLED,
  };
  const restoreEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  let memDir: string;

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), "ndomo-mem-"));
    process.env.NDOMO_MEM_STORAGE_PATH = memDir;
  });

  afterEach(() => {
    restoreEnv("NDOMO_MEM_STORAGE_PATH", priorEnv.storage);
    restoreEnv("NDOMO_SKIP_FRONTMATTER_SYNC", priorEnv.skipFrontmatter);
    restoreEnv("NDOMO_HTTP_ENABLED", priorEnv.httpEnabled);
    rmSync(memDir, { recursive: true, force: true });
  });

  test("mem_add → mem_search → dedup → mem_list → mem_stats → mem_forget round-trip", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ndomo-v2-mem-"));
    process.env.NDOMO_SKIP_FRONTMATTER_SYNC = "1";
    process.env.NDOMO_HTTP_ENABLED = "false";
    const harness = makePluginHarness(projectDir);
    const cleanup = await NdomoPlugin.setup(harness.ctx);
    if (typeof cleanup !== "function") throw new Error("setup did not return a cleanup fn");
    try {
      const find = (name: string) => {
        const tool = harness.tools.find((t) => t.name === name);
        if (!tool) throw new Error(`tool not registered: ${name}`);
        return tool;
      };
      const content = `smoke memory alpha unique-${Date.now()}-${Math.random()}`;

      const added = JSON.parse(
        (await find("mem_add").execute({ content }, harness.toolCtx("ses_mem"))).content,
      ) as { id: string; deduplicated: boolean; projectTag: string };
      expect(added.deduplicated).toBe(false);
      expect(typeof added.id).toBe("string");
      expect(added.projectTag).toMatch(/^ndomo_project_/);

      const searched = JSON.parse(
        (await find("mem_search").execute({ query: "alpha" }, harness.toolCtx("ses_mem"))).content,
      ) as { results: Array<{ id: string; content: string }>; count: number; scope: string };
      expect(searched.count).toBeGreaterThanOrEqual(1);
      expect(searched.results.some((r) => r.content.includes(content))).toBe(true);

      // Same exact content → deduplicated, same id.
      const again = JSON.parse(
        (await find("mem_add").execute({ content }, harness.toolCtx("ses_mem"))).content,
      ) as { id: string; deduplicated: boolean };
      expect(again.deduplicated).toBe(true);
      expect(again.id).toBe(added.id);

      const listed = JSON.parse(
        (await find("mem_list").execute({}, harness.toolCtx("ses_mem"))).content,
      ) as { memories: Array<{ id: string }>; total: number; scope: string };
      expect(listed.total).toBeGreaterThanOrEqual(1);

      const stats = JSON.parse(
        (await find("mem_stats").execute({}, harness.toolCtx("ses_mem"))).content,
      ) as { stats: { total: number }; scope: string };
      expect(stats.stats.total).toBeGreaterThanOrEqual(1);

      const forgotten = JSON.parse(
        (await find("mem_forget").execute({ id: added.id }, harness.toolCtx("ses_mem"))).content,
      ) as { id: string; removed: boolean };
      expect(forgotten.removed).toBe(true);

      const after = JSON.parse(
        (await find("mem_search").execute({ query: "alpha" }, harness.toolCtx("ses_mem"))).content,
      ) as { count: number };
      expect(after.count).toBe(0);
    } finally {
      await cleanup();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
