/**
 * ndomo v4 migration smoke test.
 *
 * Verifies all 6 fixes work correctly:
 *  1. priority CHECK trigger (1-4)
 *  2. slug format validation trigger (kebab-case)
 *  3. plan_progress view
 *  4. FTS5 diacritics normalization
 *  5. result/error truncation (code-level)
 *  6. metadata DEFAULT '{}' trigger
 *
 * Usage: bun run scripts/smoke-v4.ts
 */

import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/migrations.ts";
import { createPlan, getPlanProgress } from "../src/db/plans.ts";
import { createTasksBatch, getTask, updateTaskStatus } from "../src/db/tasks.ts";
import type { Plan } from "../src/db/types.ts";

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertThrows(fn: () => void, msg: string): void {
  try {
    fn();
    fail++;
    console.error(`  ✗ ${msg} (expected error, got none)`);
  } catch {
    pass++;
    console.log(`  ✓ ${msg}`);
  }
}

const PLAN_DEFAULTS = {
  title: "Test",
  status: "draft" as const,
  priority: 3,
  overview: "test",
  complexity: 3,
  createdBy: "smoke",
  updatedBy: "smoke",
  metadata: {},
  approvedAt: null,
  completedAt: null,
  sessionId: null,
  approach: null,
  sourceSessionId: null,
  sourceMessageId: null,
  category: null,
  archivedAt: null,
};

function mkPlan(
  overrides: Pick<Plan, "id" | "slug"> &
    Partial<Omit<Plan, "id" | "slug" | "createdAt" | "updatedAt">>,
): Omit<Plan, "createdAt" | "updatedAt"> {
  return { ...PLAN_DEFAULTS, ...overrides };
}

const TASK_DEFAULTS = {
  agent: "smoke",
  files: [] as string[],
  complexity: 3,
  createdBy: "smoke",
  updatedBy: "smoke",
  sourceSessionId: null,
  sourceMessageId: null,
  reviewedBy: null,
  tokensUsed: null,
  durationMs: null,
  artifacts: [] as string[],
  dependencies: [] as string[],
  metadata: {},
};

// Use in-memory DB for isolated smoke test
const db = new Database(":memory:");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

console.log("ndomo v4 smoke test\n");

// ── Run migrations ──────────────────────────────────────────────────────────
console.log("Running migrations v1→v4...");
runMigrations(db);
const ver = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
assert(ver.v >= 4, `schema_version >= 4 (got ${ver.v})`);

// ── Fix 1: priority CHECK ───────────────────────────────────────────────────
console.log("\nFix 1: priority CHECK trigger");
createPlan(db, mkPlan({ id: "p1", slug: "test-plan", priority: 1 }));
assert(true, "priority=1 accepted");

createPlan(db, mkPlan({ id: "p2", slug: "test-plan-2", priority: 4 }));
assert(true, "priority=4 accepted");

assertThrows(
  () => createPlan(db, mkPlan({ id: "p-bad", slug: "bad-priority", priority: 5 })),
  "priority=5 rejected",
);

assertThrows(
  () => createPlan(db, mkPlan({ id: "p-bad2", slug: "bad-priority-2", priority: 0 })),
  "priority=0 rejected",
);

// ── Fix 2: slug validation ──────────────────────────────────────────────────
console.log("\nFix 2: slug format validation");
assertThrows(
  () => createPlan(db, mkPlan({ id: "s-bad1", slug: "Foo Bar" })),
  "slug 'Foo Bar' rejected (space)",
);
assertThrows(
  () => createPlan(db, mkPlan({ id: "s-bad2", slug: "foo_bar" })),
  "slug 'foo_bar' rejected (underscore)",
);
assertThrows(
  () => createPlan(db, mkPlan({ id: "s-bad3", slug: "foo--bar" })),
  "slug 'foo--bar' rejected (double dash)",
);
assertThrows(
  () => createPlan(db, mkPlan({ id: "s-bad4", slug: "foo-" })),
  "slug 'foo-' rejected (trailing dash)",
);

// Valid slugs
createPlan(db, mkPlan({ id: "s-ok1", slug: "foo-bar" }));
assert(true, "slug 'foo-bar' accepted");
createPlan(db, mkPlan({ id: "s-ok2", slug: "foo123" }));
assert(true, "slug 'foo123' accepted");
createPlan(db, mkPlan({ id: "s-ok3", slug: "foo" }));
assert(true, "slug 'foo' accepted");

// ── Fix 3: plan_progress view ───────────────────────────────────────────────
console.log("\nFix 3: plan_progress view");

createTasksBatch(db, "p1", [
  { ...TASK_DEFAULTS, description: "task a", orderIndex: 0 },
  { ...TASK_DEFAULTS, description: "task b", orderIndex: 1 },
  { ...TASK_DEFAULTS, description: "task c", orderIndex: 2 },
]);

const tasks = db
  .query("SELECT id FROM plan_tasks WHERE plan_id = 'p1' ORDER BY order_index")
  .all() as Array<{ id: string }>;
const t0 = tasks[0]?.id;
const t1 = tasks[1]?.id;
const t2 = tasks[2]?.id;
if (t0) updateTaskStatus(db, t0, "done", { result: "ok" });
if (t1) updateTaskStatus(db, t1, "failed", { error: "oops" });
// t2 remains pending

const progress = getPlanProgress(db, "p1");
assert(progress.length === 1, "plan_progress returns 1 row for p1");
const p = progress[0];
if (p) {
  assert(p.totalTasks === 3, "total_tasks = 3");
  assert(p.done === 1, "done = 1");
  assert(p.failed === 1, "failed = 1");
  assert(p.pending === 1, "pending = 1");
  assert(p.progressPct === 33, "progress_pct = 33 (1/3 * 100 rounded)");
}

// All plans
const allProgress = getPlanProgress(db);
assert(allProgress.length >= 3, `plan_progress returns ${allProgress.length} rows (all plans)`);

// ── Fix 4: FTS5 diacritics ──────────────────────────────────────────────────
console.log("\nFix 4: FTS5 diacritics normalization");

createPlan(
  db,
  mkPlan({
    id: "fts1",
    slug: "fts-test",
    title: "Implementación de acción correctiva",
    overview: "Revisión del módulo de conexión",
  }),
);

const ftsResults = db
  .query("SELECT id FROM plans_fts_v2 WHERE plans_fts_v2 MATCH ?")
  .all("accion") as Array<{ id: string }>;
assert(ftsResults.length === 1, "FTS5: search 'accion' finds 'acción' (diacritics normalized)");

const ftsResults2 = db
  .query("SELECT id FROM plans_fts_v2 WHERE plans_fts_v2 MATCH ?")
  .all("implementacion") as Array<{ id: string }>;
assert(ftsResults2.length === 1, "FTS5: search 'implementacion' finds 'Implementación'");

// Task FTS
if (t0) updateTaskStatus(db, t0, "done", { result: "Corrección aplicada exitosamente" });
const taskFts = db
  .query("SELECT id FROM tasks_fts WHERE tasks_fts MATCH ?")
  .all("correccion") as Array<{ id: string }>;
assert(taskFts.length === 1, "tasks_fts: search 'correccion' finds 'Corrección'");

// ── Fix 5: result/error truncation ───────────────────────────────────────────
console.log("\nFix 5: result/error truncation");

const bigResult = "x".repeat(20 * 1024); // 20 KB
if (t2) updateTaskStatus(db, t2, "done", { result: bigResult });
const truncated = t2 ? getTask(db, t2) : null;
assert(truncated !== null, "task exists after update");
if (truncated?.result) {
  assert(
    truncated.result.length <= 16 * 1024,
    `result truncated: ${truncated.result.length} bytes <= 16384`,
  );
  assert(truncated.result.endsWith("…[truncated]"), "result ends with truncation marker");
}

// ── Fix 6: metadata DEFAULT trigger ─────────────────────────────────────────
console.log("\nFix 6: metadata DEFAULT '{}' trigger");

db.query(
  `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status, dependencies, metadata, created_by, updated_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  "meta-test",
  "p1",
  99,
  "meta test",
  "smoke",
  "[]",
  3,
  "pending",
  "[]",
  null,
  "smoke",
  "smoke",
);
const metaTask = db.query("SELECT metadata FROM plan_tasks WHERE id = 'meta-test'").get() as {
  metadata: string;
} | null;
assert(metaTask !== null, "direct insert with NULL metadata succeeded");
if (metaTask) {
  assert(metaTask.metadata === "{}", `metadata defaulted to '{}': got '${metaTask.metadata}'`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
db.close();
process.exit(fail > 0 ? 1 : 0);
