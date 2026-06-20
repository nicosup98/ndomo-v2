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
import { escalateToForeman, reconcileAbandonedPlans } from "./plugin.ts";

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
