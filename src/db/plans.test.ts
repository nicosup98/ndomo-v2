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
import { runMigrations } from "./migrations.ts";
import { approvePlan, createPlan, getPlan, updatePlanStatus } from "./plans.ts";
import { getSession } from "./sessions.ts";
import type { Plan } from "./types.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
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
