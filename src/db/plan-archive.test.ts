/**
 * Tests for plan-archive serialization — verifies original_plan_data inclusion.
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { serializePlanToMarkdown } from "./plan-archive.ts";
import { createPlan } from "./plans.ts";
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
    overview: "test overview",
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

describe("serializePlanToMarkdown", () => {
  test("includes original_plan_data section when present", () => {
    const plan = makePlan();
    // originalPlanData is set by createPlan
    const opd = plan.originalPlanData;
    expect(opd).not.toBeNull();

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    expect(md).toContain("## Original Plan Data (write-once)");
    expect(md).toContain("```json");
    expect(md).toContain(opd as string);
  });

  test("omits original_plan_data section when null", () => {
    // Construct a raw Plan object without going through createPlan
    // (createPlan always sets originalPlanData)
    const plan: Plan = {
      id: crypto.randomUUID(),
      slug: "no-opd",
      title: "No OPD",
      status: "draft",
      priority: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
      originalPlanData: null,
    };

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    expect(md).not.toContain("## Original Plan Data (write-once)");
  });

  test("includes agent trail section when createdByAgent is set", () => {
    const plan = makePlan({ createdByAgent: "foreman" });

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    expect(md).toContain("## Agent Trail");
    expect(md).toContain("**Created by agent:** foreman");
  });

  test("includes executed_by_agent when set", () => {
    const plan = makePlan({
      createdByAgent: "foreman",
      executedByAgent: "craftsman",
      executedBySession: "ses_123",
    });

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    expect(md).toContain("**Executed by agent:** craftsman");
    expect(md).toContain("**Executed by session:** ses_123");
  });

  test("JSON with triple backticks does not break markdown", () => {
    // Construct plan with originalPlanData containing triple backticks
    const plan: Plan = {
      id: crypto.randomUUID(),
      slug: "backtick-test",
      title: "Backtick Test",
      status: "draft",
      priority: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
      originalPlanData: '{"code":"```js\\nconsole.log(1)\\n```"}',
    };

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    // Should contain the sanitized version
    expect(md).toContain("## Original Plan Data (write-once)");
    // The triple backticks should be escaped so inner code blocks don't break markdown
    expect(md).not.toContain("```js\nconsole.log(1)\n```");
    // Verify the escaped version is present instead
    expect(md).toContain("\\`\\`\\`js");
  });

  test("JSON without triple backticks is unmodified", () => {
    const plan: Plan = {
      id: crypto.randomUUID(),
      slug: "normal-test",
      title: "Normal Test",
      status: "draft",
      priority: 2,
      createdAt: Date.now(),
      updatedAt: Date.now(),
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
      originalPlanData: '{"slug":"test","title":"Test"}',
    };

    const md = serializePlanToMarkdown(plan, [], [], Date.now());

    expect(md).toContain('{"slug":"test","title":"Test"}');
  });
});
