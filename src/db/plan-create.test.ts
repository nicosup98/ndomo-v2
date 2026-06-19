/**
 * Integration tests for planCreateExecutor — the extracted plan_create tool logic.
 *
 * Validates that the executor correctly:
 * - Persists a plan with all mapped fields
 * - Auto-creates a session row when ctx.sessionID is provided
 * - Skips session creation when ctx.sessionID is undefined
 * - Passes through metadata, priority, complexity, and other optional fields
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 *
 * NOTE: The DB enforces priority 1-4 via CHECK trigger, so all tests
 * pass explicit priority values to avoid the default-0 constraint error.
 * The executor's `priority: args.priority ?? 0` matches the original code.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { planCreateExecutor } from "./plan-create.ts";
import { getPlan } from "./plans.ts";
import { getSession } from "./sessions.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("planCreateExecutor", () => {
  test("creates plan in DB with correct fields", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "test-2026-06-19", title: "My Test Plan", overview: "do stuff", priority: 2 },
      { agent: "foreman", sessionID: "ses_test_int", messageID: "msg_test_int" },
    );
    expect(plan.slug).toBe("test-2026-06-19");
    expect(plan.title).toBe("My Test Plan");
    expect(plan.overview).toBe("do stuff");
    expect(plan.status).toBe("draft");
    expect(plan.priority).toBe(2);
    expect(plan.complexity).toBe(3);
    expect(plan.createdBy).toBe("foreman");
    expect(plan.updatedBy).toBe("foreman");
    expect(plan.sourceSessionId).toBe("ses_test_int");
    expect(plan.sourceMessageId).toBe("msg_test_int");
    // Verify it actually persisted
    const fetched = getPlan(db, plan.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.slug).toBe("test-2026-06-19");
  });

  test("auto-creates session row with goal derived from title", () => {
    planCreateExecutor(
      db,
      { slug: "s2", title: "Title Two", overview: "o", priority: 2 },
      { agent: "foreman", sessionID: "ses_auto_test" },
    );
    const sess = getSession(db, "ses_auto_test");
    expect(sess).not.toBeNull();
    expect(sess?.goal).toBe("Plan: Title Two");
    expect(sess?.createdBy).toBe("auto");
  });

  test("does NOT create session when ctx.sessionID is undefined", () => {
    planCreateExecutor(
      db,
      { slug: "s3", title: "No Sess", overview: "o", priority: 2 },
      { agent: "foreman" }, // no sessionID
    );
    // Verify NO row in sessions table (the executor guarded the call)
    const rows = db.query("SELECT * FROM sessions").all();
    expect(rows).toHaveLength(0);
  });

  test("defaults agent to 'unknown' when ctx.agent is undefined", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "s4", title: "No Agent", overview: "o", priority: 2 },
      {}, // no agent
    );
    expect(plan.createdBy).toBe("unknown");
    expect(plan.updatedBy).toBe("unknown");
  });

  test("respects custom priority and complexity", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "s5", title: "Custom", overview: "o", priority: 4, complexity: 1 },
      { agent: "test" },
    );
    expect(plan.priority).toBe(4);
    expect(plan.complexity).toBe(1);
  });

  test("passes through approach field", () => {
    const plan = planCreateExecutor(
      db,
      { slug: "s6", title: "With Approach", overview: "o", priority: 2, approach: "TDD first" },
      { agent: "test" },
    );
    expect(plan.approach).toBe("TDD first");
  });

  test("passes through metadata with category", () => {
    const plan = planCreateExecutor(
      db,
      {
        slug: "s7",
        title: "With Meta",
        overview: "o",
        priority: 2,
        metadata: { category: "bugfix" },
      },
      { agent: "test" },
    );
    expect(plan.category).toBe("bugfix");
    expect(plan.metadata.category).toBe("bugfix");
  });

  test("sessionId arg is stored on plan (distinct from ctx.sessionID)", () => {
    const plan = planCreateExecutor(
      db,
      {
        slug: "s8",
        title: "Linked",
        overview: "o",
        priority: 2,
        sessionId: "ses_linked",
      },
      { agent: "test", sessionID: "ses_source" },
    );
    // args.sessionId → plan.sessionId (the FK link)
    expect(plan.sessionId).toBe("ses_linked");
    // ctx.sessionID → plan.sourceSessionId (the origin)
    expect(plan.sourceSessionId).toBe("ses_source");
  });
});
