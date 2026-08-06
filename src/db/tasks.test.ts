/**
 * Tests for task CRUD, executed_by write-once, and plan_files insertion.
 *
 * Uses in-memory SQLite via bun:sqlite. Each test gets a fresh DB
 * with the full schema applied by runMigrations.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import { createPlan, getPlan } from "./plans.ts";
import { getSession } from "./sessions.ts";
import {
  createTasksBatch,
  getTask,
  listTasksByPlan,
  nextTaskForAgent,
  splitFilesByStack,
  updateTaskStatus,
} from "./tasks.ts";
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
    owner: "foreman",
    metadata: {},
    archivedAt: null,
    ...overrides,
  });
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    orderIndex: 0,
    description: "test task",
    agent: "js-smith",
    files: [] as string[],
    complexity: 1,
    dependencies: [] as string[],
    createdBy: "foreman",
    updatedBy: "foreman",
    sourceSessionId: null as string | null,
    sourceMessageId: null as string | null,
    reviewedBy: null as string | null,
    tokensUsed: null as number | null,
    durationMs: null as number | null,
    artifacts: [] as string[],
    metadata: {},
    ...overrides,
  };
}

// ─── Issue 2: executed_by write-once ─────────────────────────────────────────

describe("updateTaskStatus — executed_by write-once", () => {
  test("transition to 'running' sets plan.executed_by_agent", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;

    updateTaskStatus(db, taskId, "running", undefined, "js-smith", {
      agent: "js-smith",
      sessionId: "ses_123",
    });

    const updated = getPlan(db, plan.id);
    expect(updated?.executedByAgent).toBe("js-smith");
    expect(updated?.executedBySession).toBe("ses_123");
  });

  test("two 'running' transitions — no overwrite (write-once)", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask(), makeTask({ orderIndex: 1 })]);

    // First task starts
    updateTaskStatus(db, tasks[0]?.id as string, "running", undefined, "agent-A", {
      agent: "agent-A",
      sessionId: "ses_A",
    });

    // Second task starts — should NOT overwrite
    updateTaskStatus(db, tasks[1]?.id as string, "running", undefined, "agent-B", {
      agent: "agent-B",
      sessionId: "ses_B",
    });

    const updated = getPlan(db, plan.id);
    expect(updated?.executedByAgent).toBe("agent-A");
    expect(updated?.executedBySession).toBe("ses_A");
  });

  test("transition to 'done' does NOT change plan.executed_by_agent", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);

    // First set running
    updateTaskStatus(db, tasks[0]?.id as string, "running", undefined, "js-smith", {
      agent: "js-smith",
      sessionId: "ses_123",
    });

    // Then set done
    updateTaskStatus(db, tasks[0]?.id as string, "done", { result: "ok" }, "js-smith", {
      agent: "js-smith",
      sessionId: "ses_123",
    });

    const updated = getPlan(db, plan.id);
    expect(updated?.executedByAgent).toBe("js-smith"); // unchanged from running
    expect(updated?.executedBySession).toBe("ses_123");
  });

  test("no ctx provided — no executed_by write", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);

    updateTaskStatus(db, tasks[0]?.id as string, "running", undefined, "js-smith");

    const updated = getPlan(db, plan.id);
    expect(updated?.executedByAgent).toBeNull();
    expect(updated?.executedBySession).toBeNull();
  });
});

// ─── Issue 4: createTasksBatch plan_files insertion ──────────────────────────

describe("createTasksBatch — plan_files insertion", () => {
  test("task.files inserts rows with role='modified'", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [makeTask({ files: ["src/a.ts", "src/b.ts"] })]);

    const rows = db
      .query("SELECT * FROM plan_files WHERE plan_id = ? ORDER BY file_path")
      .all(plan.id) as Array<{ plan_id: string; file_path: string; role: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]?.file_path).toBe("src/a.ts");
    expect(rows[0]?.role).toBe("modified");
    expect(rows[1]?.file_path).toBe("src/b.ts");
    expect(rows[1]?.role).toBe("modified");
  });

  test("duplicate files across tasks — no break (INSERT OR IGNORE)", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      makeTask({ files: ["src/shared.ts"], description: "task A" }),
      makeTask({ orderIndex: 1, files: ["src/shared.ts", "src/other.ts"], description: "task B" }),
    ]);

    const rows = db.query("SELECT * FROM plan_files WHERE plan_id = ?").all(plan.id) as Array<{
      file_path: string;
    }>;

    // shared.ts appears once (PK dedup), other.ts once = 2 total
    expect(rows).toHaveLength(2);
  });

  test("no files — 0 rows in plan_files", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [makeTask()]);

    const rows = db.query("SELECT * FROM plan_files WHERE plan_id = ?").all(plan.id);

    expect(rows).toHaveLength(0);
  });
});

// ─── High 3: ensureSession before setExecutedByOnce ─────────────────────────

describe("updateTaskStatus — ensureSession FK safety", () => {
  test("running with non-existent sessionId creates session automatically", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;
    const sessionId = `ses_${crypto.randomUUID()}`;

    // Session should NOT exist yet
    expect(getSession(db, sessionId)).toBeNull();

    updateTaskStatus(db, taskId, "running", undefined, "js-smith", {
      agent: "js-smith",
      sessionId,
    });

    // Session should now exist (auto-created by ensureSession)
    const session = getSession(db, sessionId);
    expect(session).not.toBeNull();
    expect(session?.id).toBe(sessionId);

    // Plan executed_by should also be set
    const updated = getPlan(db, plan.id);
    expect(updated?.executedByAgent).toBe("js-smith");
    expect(updated?.executedBySession).toBe(sessionId);
  });
});

// ─── P3: nextTaskForAgent atomic claim (race condition fix) ─────────────────

describe("nextTaskForAgent — atomic claim", () => {
  test("returns pending task and sets status=running atomically", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      makeTask({ orderIndex: 0, agent: "js-smith" }),
      makeTask({ orderIndex: 1, agent: "js-smith" }),
    ]);

    const task = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(task).not.toBeNull();
    expect(task?.status).toBe("running");
    expect(task?.startedAt).toBeGreaterThan(0);
    expect(task?.orderIndex).toBe(0);
  });

  test("second call claims next pending task (not already-running)", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      makeTask({ orderIndex: 0, agent: "js-smith", description: "task A" }),
      makeTask({ orderIndex: 1, agent: "js-smith", description: "task B" }),
    ]);

    const first = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    const second = nextTaskForAgent(db, "js-smith", { planId: plan.id });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
    expect(first?.orderIndex).toBe(0);
    expect(second?.orderIndex).toBe(1);
    expect(second?.status).toBe("running");
  });

  test("returns null when no pending tasks for agent", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [makeTask({ agent: "other-agent" })]);

    const task = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(task).toBeNull();
  });

  test("claims across plans when planId omitted", () => {
    const plan1 = makePlan({ slug: "plan-1" });
    const plan2 = makePlan({ slug: "plan-2" });
    createTasksBatch(db, plan1.id, [makeTask({ agent: "js-smith" })]);
    createTasksBatch(db, plan2.id, [makeTask({ agent: "js-smith" })]);

    const task = nextTaskForAgent(db, "js-smith");
    expect(task).not.toBeNull();
    expect(task?.status).toBe("running");
  });

  test("skips archived tasks", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask({ agent: "js-smith" })]);

    // Archive the task
    const archivedTask = tasks[0];
    if (!archivedTask) throw new Error("test setup: expected at least one task");
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(Date.now(), archivedTask.id);

    const task = nextTaskForAgent(db, "js-smith", { planId: plan.id });
    expect(task).toBeNull();
  });
});

// ─── F1: createTasksBatch no-overlap pre-dispatch ───────────────────────────

describe("createTasksBatch — no-overlap pre-dispatch", () => {
  test("skips task with same (agent, description) already exists", () => {
    const plan = makePlan();
    const first = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module" }),
    ]);
    expect(first).toHaveLength(1);

    // Attempt duplicate — should be skipped
    const second = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module" }),
    ]);
    expect(second).toHaveLength(0);

    // Verify only one task in DB
    const rows = db
      .query("SELECT * FROM plan_tasks WHERE plan_id = ? AND archived_at IS NULL")
      .all(plan.id);
    expect(rows).toHaveLength(1);
  });

  test("different agent same description — allowed", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module" }),
    ]);

    const result = createTasksBatch(db, plan.id, [
      makeTask({ agent: "reviewer", description: "build auth module", orderIndex: 1 }),
    ]);
    expect(result).toHaveLength(1);
  });

  test("same agent different description — allowed", () => {
    const plan = makePlan();
    createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module" }),
    ]);

    const result = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth tests", orderIndex: 1 }),
    ]);
    expect(result).toHaveLength(1);
  });

  test("in-batch duplicates also skipped", () => {
    const plan = makePlan();
    const result = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module", orderIndex: 0 }),
      makeTask({ agent: "js-smith", description: "build auth module", orderIndex: 1 }),
    ]);
    // First insert, second skipped
    expect(result).toHaveLength(1);
  });

  test("overlap check includes non-archived tasks only", () => {
    const plan = makePlan();
    const first = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module" }),
    ]);

    // Archive it
    const archivedFirst = first[0];
    if (!archivedFirst) throw new Error("test setup: expected at least one task");
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(
      Date.now(),
      archivedFirst.id,
    );

    // Re-create same task — should succeed (archived doesn't block)
    // Use different orderIndex since archived row still occupies (plan_id, order_index)
    const second = createTasksBatch(db, plan.id, [
      makeTask({ agent: "js-smith", description: "build auth module", orderIndex: 1 }),
    ]);
    expect(second).toHaveLength(1);
  });
});

// ─── M5: original_plan_data snapshot completeness ───────────────────────────

describe("createTasksBatch — original_plan_data snapshot (M5)", () => {
  test("snapshot includes files", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask({ files: ["src/a.ts", "src/b.ts"] })]);
    const snapshot = JSON.parse(tasks[0]?.originalPlanData ?? "{}");

    expect(snapshot.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("snapshot includes metadata", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ metadata: { reviewedBy: "chronicler", tokensUsed: 1500 } }),
    ]);
    const snapshot = JSON.parse(tasks[0]?.originalPlanData ?? "{}");

    expect(snapshot.metadata).toEqual({ reviewedBy: "chronicler", tokensUsed: 1500 });
  });

  test("snapshot includes dependencies", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask({ dependencies: ["dep-1", "dep-2"] })]);
    const snapshot = JSON.parse(tasks[0]?.originalPlanData ?? "{}");

    expect(snapshot.dependencies).toEqual(["dep-1", "dep-2"]);
  });

  test("snapshot includes empty arrays/objects when fields omitted", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const snapshot = JSON.parse(tasks[0]?.originalPlanData ?? "{}");

    expect(snapshot.files).toEqual([]);
    expect(snapshot.dependencies).toEqual([]);
    expect(snapshot.metadata).toEqual({});
  });
});

// ─── M6: truncation warning + return metadata ───────────────────────────────

describe("updateTaskStatus — truncation metadata (M6)", () => {
  test("result > 16KB → truncated:true with correct lengths", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;
    const bigResult = "x".repeat(17 * 1024); // 17 KB

    const originalWarn = console.warn;
    const warnCalls: unknown[][] = [];
    console.warn = (...args: unknown[]) => warnCalls.push(args);

    const result = updateTaskStatus(db, taskId, "done", { result: bigResult }, "test");

    expect(result?.truncation.truncated).toBe(true);
    expect(result?.truncation.originalLength).toBe(17 * 1024);
    expect(result?.truncation.truncatedLength).toBe(16 * 1024);
    expect(result?.result).toContain("…[truncated]");
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(String(warnCalls[0]?.[0])).toContain(`task_update_status ${taskId}`);

    console.warn = originalWarn;
  });

  test("result exactly 16KB → truncated:false", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;
    const exactResult = "y".repeat(16 * 1024); // exactly 16 KB

    const result = updateTaskStatus(db, taskId, "done", { result: exactResult }, "test");

    expect(result?.truncation.truncated).toBe(false);
    expect(result?.truncation.originalLength).toBeUndefined();
    expect(result?.result).toBe(exactResult);
  });

  test("error field also truncated with same behavior", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;
    const bigError = "e".repeat(20 * 1024); // 20 KB

    const originalWarn = console.warn;
    console.warn = () => {};

    const result = updateTaskStatus(db, taskId, "failed", { error: bigError }, "test");

    expect(result?.truncation.truncated).toBe(true);
    expect(result?.truncation.originalLength).toBe(20 * 1024);
    expect(result?.truncation.truncatedLength).toBe(16 * 1024);
    expect(result?.error).toContain("…[truncated]");

    console.warn = originalWarn;
  });
});

// ─── M7: cross-stack file splitting ─────────────────────────────────────────

describe("splitFilesByStack (M7)", () => {
  test("groups files by extension stack", () => {
    const result = splitFilesByStack(["main.go", "app.ts", "style.vue"]);

    expect(Object.keys(result)).toHaveLength(3);
    expect(result.go).toEqual(["main.go"]);
    expect(result.js).toEqual(["app.ts"]);
    expect(result.vue).toEqual(["style.vue"]);
  });

  test("unknown extension → 'other'", () => {
    const result = splitFilesByStack(["file.xyz", "main.go"]);

    expect(result.other).toEqual(["file.xyz"]);
    expect(result.go).toEqual(["main.go"]);
  });

  test("single file → single stack", () => {
    const result = splitFilesByStack(["main.go"]);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result.go).toEqual(["main.go"]);
  });

  test("same extension → no split (one stack)", () => {
    const result = splitFilesByStack(["a.go", "b.go"]);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result.go).toEqual(["a.go", "b.go"]);
  });

  test("tsx/jsx/ts/js all map to 'js'", () => {
    const result = splitFilesByStack(["a.ts", "b.tsx", "c.js", "d.jsx"]);

    expect(Object.keys(result)).toHaveLength(1);
    expect(result.js).toEqual(["a.ts", "b.tsx", "c.js", "d.jsx"]);
  });
});

describe("createTasksBatch — cross-stack split (M7)", () => {
  test("task with main.go + app.ts → 2 tasks (go-smith, js-smith)", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ files: ["main.go", "app.ts"], description: "build feature" }),
    ]);

    expect(tasks).toHaveLength(2);

    const goTask = tasks.find((t) => t.agent === "go-smith");
    const jsTask = tasks.find((t) => t.agent === "js-smith");

    expect(goTask).toBeDefined();
    expect(jsTask).toBeDefined();
    expect(goTask?.files).toEqual(["main.go"]);
    expect(jsTask?.files).toEqual(["app.ts"]);
  });

  test("task with main.go + main.go → no split (same stack, dedup files)", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ files: ["main.go", "main.go"], description: "build backend" }),
    ]);

    // Same stack → no split, original task used as-is
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent).toBe("js-smith"); // original agent preserved
  });

  test("task with single file → 1 task, no split", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ files: ["main.go"], description: "build backend" }),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent).toBe("js-smith"); // original agent preserved
  });

  test("task with file.unknown + main.go → 2 tasks (other + go)", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ files: ["README.xyz", "main.go"], description: "build docs" }),
    ]);

    expect(tasks).toHaveLength(2);

    const otherTask = tasks.find((t) => t.agent === "smith");
    const goTask = tasks.find((t) => t.agent === "go-smith");

    expect(otherTask).toBeDefined();
    expect(goTask).toBeDefined();
    expect(otherTask?.files).toEqual(["README.xyz"]);
    expect(goTask?.files).toEqual(["main.go"]);
  });

  test("splitReason='cross-stack' in metadata of sub-tasks", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ files: ["main.go", "app.ts"], description: "build feature" }),
    ]);

    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect((task.metadata as Record<string, unknown>).splitReason).toBe("cross-stack");
    }
  });
});

// ─── T1: updateTaskStatus — extended fields ──────────────────────────────────

describe("updateTaskStatus — extended fields (T1)", () => {
  test("artifacts write", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;

    updateTaskStatus(db, taskId, "done", { artifacts: ["file1.ts", "file2.ts"] });

    const row = db.query("SELECT artifacts FROM plan_tasks WHERE id = ?").get(taskId) as {
      artifacts: string;
    };
    expect(JSON.parse(row.artifacts)).toEqual(["file1.ts", "file2.ts"]);
  });

  test("artifacts truncation", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;

    // Build artifacts array whose JSON > 16KB
    const longStrings = Array.from({ length: 200 }, (_, i) => `file${"x".repeat(100)}_${i}.ts`);
    const warnSpy = { calls: [] as string[] };
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnSpy.calls.push(args.join(" "));
      origWarn(...args);
    };

    try {
      const result = updateTaskStatus(db, taskId, "done", { artifacts: longStrings });

      expect(result?.truncation.truncated).toBe(true);
      expect(warnSpy.calls.some((m) => m.includes("artifacts truncated"))).toBe(true);

      const row = db.query("SELECT artifacts FROM plan_tasks WHERE id = ?").get(taskId) as {
        artifacts: string;
      };
      const stored: string[] = JSON.parse(row.artifacts);
      expect(stored.length).toBeLessThan(longStrings.length);
      // Stored JSON must fit within 16KB
      expect(JSON.stringify(stored).length).toBeLessThanOrEqual(16 * 1024);
    } finally {
      console.warn = origWarn;
    }
  });

  test("metadataPatch deep merge", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [
      makeTask({ metadata: { a: 1, b: { x: 1 } } as unknown as Record<string, unknown> }),
    ]);
    const taskId = tasks[0]?.id as string;

    updateTaskStatus(db, taskId, "done", { metadataPatch: { b: { y: 2 }, c: 3 } });

    const task = getTask(db, taskId);
    expect(task?.metadata as unknown as Record<string, unknown>).toEqual({
      a: 1,
      b: { x: 1, y: 2 },
      c: 3,
    });
  });

  test("reviewedBy write", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;

    updateTaskStatus(db, taskId, "done", { reviewedBy: "inspector" });

    const row = db.query("SELECT reviewed_by FROM plan_tasks WHERE id = ?").get(taskId) as {
      reviewed_by: string;
    };
    expect(row.reviewed_by).toBe("inspector");
  });

  test("reviewedVerdict stored in metadata", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask()]);
    const taskId = tasks[0]?.id as string;

    updateTaskStatus(db, taskId, "done", { reviewedVerdict: "approved" });

    const task = getTask(db, taskId);
    expect((task?.metadata as Record<string, unknown>).reviewedVerdict).toBe("approved");
  });

  test("retrocompat — undefined fields = no-write", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask({ artifacts: ["existing.ts"] })]);
    const taskId = tasks[0]?.id as string;

    // Update with only result — artifacts/metadata/reviewedBy should stay unchanged
    updateTaskStatus(db, taskId, "done", { result: "ok" });

    const row = db
      .query("SELECT artifacts, reviewed_by, metadata FROM plan_tasks WHERE id = ?")
      .get(taskId) as { artifacts: string; reviewed_by: string | null; metadata: string };
    expect(JSON.parse(row.artifacts)).toEqual(["existing.ts"]);
    expect(row.reviewed_by).toBeNull();
  });

  test("combined — all fields at once", () => {
    const plan = makePlan();
    const tasks = createTasksBatch(db, plan.id, [makeTask({ metadata: { existing: true } })]);
    const taskId = tasks[0]?.id as string;

    const result = updateTaskStatus(db, taskId, "done", {
      result: "final output",
      artifacts: ["a.ts", "b.ts"],
      metadataPatch: { newKey: 42 },
      reviewedBy: "warden",
      reviewedVerdict: "pass",
    });

    expect(result?.result).toBe("final output");

    const row = db
      .query("SELECT artifacts, reviewed_by, metadata FROM plan_tasks WHERE id = ?")
      .get(taskId) as { artifacts: string; reviewed_by: string; metadata: string };
    expect(JSON.parse(row.artifacts)).toEqual(["a.ts", "b.ts"]);
    expect(row.reviewed_by).toBe("warden");
    const meta = JSON.parse(row.metadata);
    expect(meta.existing).toBe(true);
    expect(meta.newKey).toBe(42);
    expect(meta.reviewedVerdict).toBe("pass");
  });
});

// ─── order_index collision-safe allocation (fix: plan ca69222a) ──────────────

describe("createTasksBatch — order_index collision-safe allocation", () => {
  test("(a) batch con plan pre-poblado — nueva task asigna order_index=1 sin colisión", () => {
    const plan = makePlan();
    // Pre-populate with 1 task at order_index=0
    createTasksBatch(db, plan.id, [makeTask({ description: "existing task" })]);

    // New batch — caller passes orderIndex=0 (collides with existing)
    const result = createTasksBatch(db, plan.id, [
      makeTask({ description: "new task", orderIndex: 0 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.orderIndex).toBe(1);
    expect(result[0]?.description).toBe("new task");
  });

  test("(b) split cross-stack con plan pre-poblado — parent=1, decimal 1.1", () => {
    const plan = makePlan();
    // Pre-populate with 1 task at order_index=0
    createTasksBatch(db, plan.id, [makeTask({ description: "existing task" })]);

    // New batch with cross-stack files: .py+.py → python, .md → other = 2 stacks
    const result = createTasksBatch(db, plan.id, [
      makeTask({ files: ["a.py", "b.py", "c.md"], description: "split task" }),
    ]);

    expect(result).toHaveLength(2);
    // Parent (first sub-task) → order_index=1 (next free after 0)
    // Second sub-task → 1 + 0.1 = 1.1
    const orderIndices = result.map((t) => t.orderIndex).sort((a, b) => a - b);
    expect(orderIndices).toEqual([1, 1.1]);
  });

  test("(c) split cross-stack — decimales ocupados → escala a integer libre", () => {
    const plan = makePlan();
    // Pre-populate with tasks at 0.1 and 0.2 (but NOT 0)
    createTasksBatch(db, plan.id, [
      makeTask({ description: "task at 0.1", orderIndex: 0.1, agent: "agent-X" }),
      makeTask({ description: "task at 0.2", orderIndex: 0.2, agent: "agent-Y" }),
    ]);

    // New batch with 3-stack split, caller passes orderIndex=0
    // .go + .ts + .py → 3 stacks → 3 sub-tasks
    const result = createTasksBatch(db, plan.id, [
      makeTask({ files: ["a.go", "b.ts", "c.py"], description: "split task", orderIndex: 0 }),
    ]);

    expect(result).toHaveLength(3);
    // stackIdx=0 → parentOrder=0 (free)
    // stackIdx=1 → 0.1 (occupied) → escalate to next free integer = 1
    // stackIdx=2 → 0.2 (occupied) → escalate to next free integer = 2
    const orderIndices = result.map((t) => t.orderIndex).sort((a, b) => a - b);
    expect(orderIndices).toEqual([0, 1, 2]);
  });

  test("(d) caller pasa orderIndex colisionante → core reasigna a siguiente libre", () => {
    const plan = makePlan();
    // Pre-populate with task at order_index=0
    createTasksBatch(db, plan.id, [makeTask({ description: "existing task" })]);

    // New batch — caller passes orderIndex=0 (collides)
    const result = createTasksBatch(db, plan.id, [
      makeTask({ description: "new task", orderIndex: 0 }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.orderIndex).toBe(1); // reassigned to next free
  });

  test("(e) reproduce bug 18252705 — 2nd batch with colliding orderIndex succeeds", () => {
    const plan = makePlan();
    // 1st batch — 1 task at order_index=0 (simulates old caller passing idx=0)
    const first = createTasksBatch(db, plan.id, [
      makeTask({ description: "task 0", orderIndex: 0 }),
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]?.orderIndex).toBe(0);

    // 2nd batch — 4 tasks. OLD callers passed orderIndex 0,1,2,3 (idx from map).
    // With fix, even if caller passes colliding indices, core reassigns.
    const second = createTasksBatch(db, plan.id, [
      makeTask({ description: "task A", orderIndex: 0 }), // collides → 1
      makeTask({ description: "task B", orderIndex: 1 }), // collides → 2
      makeTask({ description: "task C", orderIndex: 2 }), // collides → 3
      makeTask({ description: "task D", orderIndex: 3 }), // collides → 4
    ]);

    expect(second).toHaveLength(4);
    const orderIndices = second.map((t) => t.orderIndex).sort((a, b) => a - b);
    expect(orderIndices).toEqual([1, 2, 3, 4]);
  });

  test("(f) caller omite orderIndex — core asigna secuencial desde MAX+1", () => {
    const plan = makePlan();
    // 1st batch — 2 tasks, no orderIndex specified
    const first = createTasksBatch(db, plan.id, [
      makeTask({ description: "task X" }),
      makeTask({ description: "task Y" }),
    ]);
    expect(first).toHaveLength(2);
    expect(first[0]?.orderIndex).toBe(0);
    expect(first[1]?.orderIndex).toBe(1);

    // 2nd batch — 2 more tasks, no orderIndex
    const second = createTasksBatch(db, plan.id, [
      makeTask({ description: "task Z" }),
      makeTask({ description: "task W" }),
    ]);
    expect(second).toHaveLength(2);
    expect(second[0]?.orderIndex).toBe(2);
    expect(second[1]?.orderIndex).toBe(3);
  });

  test("(g) archived task ocupa slot — nueva task evita colisión", () => {
    const plan = makePlan();
    // Create and archive a task at order_index=0
    const created = createTasksBatch(db, plan.id, [makeTask({ description: "archived task" })]);
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(
      Date.now(),
      created[0]?.id as string,
    );

    // New batch — caller passes orderIndex=0 (collides with archived row)
    const result = createTasksBatch(db, plan.id, [
      makeTask({ description: "new task", orderIndex: 0 }),
    ]);

    expect(result).toHaveLength(1);
    // Archived row still occupies (plan_id, order_index) in UNIQUE constraint.
    // Core detects collision via usedOrderIndices (includes archived) → reassigns.
    expect(result[0]?.orderIndex).not.toBe(0);
  });
});

// ─── listTasksByPlan — includeArchived flag (plan 76a12c8d) ──────────────────

describe("listTasksByPlan — includeArchived flag", () => {
  test("(a) sin flag — omite tasks con archived_at IS NOT NULL", () => {
    const plan = makePlan();
    // Create 2 tasks: one live, one to be archived
    const created = createTasksBatch(db, plan.id, [
      makeTask({ description: "live task" }),
      makeTask({ description: "doomed task" }),
    ]);
    expect(created).toHaveLength(2);

    // Archive the 2nd task
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(
      Date.now(),
      created[1]?.id as string,
    );

    // Default call (no includeArchived) → only live task
    const tasks = listTasksByPlan(db, plan.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.description).toBe("live task");
    expect(tasks[0]?.archivedAt).toBeNull();
  });

  test("(b) includeArchived=true — retorna tasks archivadas también", () => {
    const plan = makePlan();
    const created = createTasksBatch(db, plan.id, [
      makeTask({ description: "live task" }),
      makeTask({ description: "archived task" }),
    ]);
    expect(created).toHaveLength(2);

    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(
      Date.now(),
      created[1]?.id as string,
    );

    // With includeArchived=true → both tasks returned
    const tasks = listTasksByPlan(db, plan.id, { includeArchived: true });
    expect(tasks).toHaveLength(2);
    const descriptions = tasks.map((t) => t.description).sort();
    expect(descriptions).toEqual(["archived task", "live task"]);
    // Archived task carries archivedAt timestamp
    const archived = tasks.find((t) => t.description === "archived task");
    expect(archived?.archivedAt).not.toBeNull();
  });

  test("(c) includeArchived=true + status filter — combina ambos filtros", () => {
    const plan = makePlan();
    const created = createTasksBatch(db, plan.id, [
      makeTask({ description: "live pending" }),
      makeTask({ description: "archived pending" }),
      makeTask({ description: "live done" }),
    ]);
    // Archive 2nd task, mark 3rd as done
    db.query("UPDATE plan_tasks SET archived_at = ? WHERE id = ?").run(
      Date.now(),
      created[1]?.id as string,
    );
    updateTaskStatus(db, created[2]?.id as string, "done", { result: "ok" }, "test");

    // status=pending + includeArchived=true → both pending tasks (live + archived)
    const pendingAll = listTasksByPlan(db, plan.id, {
      status: "pending",
      includeArchived: true,
    });
    expect(pendingAll).toHaveLength(2);
    expect(pendingAll.map((t) => t.description).sort()).toEqual([
      "archived pending",
      "live pending",
    ]);

    // status=pending without includeArchived → only live pending
    const pendingLive = listTasksByPlan(db, plan.id, { status: "pending" });
    expect(pendingLive).toHaveLength(1);
    expect(pendingLive[0]?.description).toBe("live pending");
  });
});
