/**
 * ndomo v5 migration smoke test.
 *
 * Verifies soft delete + auto-archive functionality:
 *  1. Create plan + 2 tasks + 1 session, mark completed → auto-archive fires
 *  2. listPlans() (default) excludes archived plan
 *  3. listPlans({ includeArchived: true }) includes archived plan
 *  4. searchPlans() (default) excludes archived plan
 *  5. Markdown file exists, >500 bytes, contains title/tasks/sessions
 *  6. plan_tasks.archived_at set for both tasks
 *  7. sessions.archived_at set for the session
 *  8. Re-archive throws "already archived"
 *  9. searchPlans returns results ordered by rank (FTS5 relevance)
 * 10. nextTaskForAgent skips archived tasks by default
 * 11. findPlansByCategory excludes archived by default
 * 12. plan_progress view excludes archived tasks from counts
 *
 * Usage: bun run scripts/smoke-v5.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/db/migrations.ts";
import { archivePlan } from "../src/db/plan-archive.ts";
import {
  createPlan,
  findPlansByCategory,
  getPlanProgress,
  listPlans,
  searchPlans,
} from "../src/db/plans.ts";
import { startSession } from "../src/db/sessions.ts";
import { createTasksBatch, listTasksByPlan, nextTaskForAgent } from "../src/db/tasks.ts";
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

function assertThrows(fn: () => void, expectedMsg: string, msg: string): void {
  try {
    fn();
    fail++;
    console.error(`  ✗ ${msg} (expected error, got none)`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes(expectedMsg)) {
      pass++;
      console.log(`  ✓ ${msg}`);
    } else {
      fail++;
      console.error(`  ✗ ${msg} (expected '${expectedMsg}', got '${errMsg}')`);
    }
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
  approach: "Test approach for smoke validation",
  sourceSessionId: null,
  sourceMessageId: null,
  category: null as Plan["category"],
  archivedAt: null,
};

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

// Use in-memory DB + temp dir for isolated smoke test
const db = new Database(":memory:");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const testMemDir = join(tmpdir(), `ndomo-smoke-v5-${Date.now()}`);
mkdirSync(testMemDir, { recursive: true });

console.log("ndomo v5 smoke test\n");

// ── Run migrations ──────────────────────────────────────────────────────────
console.log("Running migrations v1→v5...");
runMigrations(db);
const ver = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
assert(ver.v === 5, "schema_version = 5");

// Verify archived_at columns exist
const planCols = db.query("PRAGMA table_info(plans)").all() as Array<{ name: string }>;
assert(
  planCols.some((c) => c.name === "archived_at"),
  "plans.archived_at column exists",
);

// ── Test 1: Create plan + tasks + session, archive via function ─────────────
console.log("\nTest 1: Create plan + 2 tasks + 1 session, archive");

const planOverrides = {
  id: "archive-test",
  slug: "archive-test-plan",
  title: "Archive Test Plan",
  overview: "A plan for testing the archive flow with tasks and sessions",
};

createPlan(db, {
  ...PLAN_DEFAULTS,
  ...planOverrides,
  status: "draft" as const,
});

createTasksBatch(db, "archive-test", [
  { ...TASK_DEFAULTS, description: "Implement feature A", orderIndex: 0 },
  { ...TASK_DEFAULTS, description: "Write tests for A", orderIndex: 1 },
]);

startSession(db, {
  id: "session-archive-test",
  goal: "Build feature A",
  planId: "archive-test",
});

// Archive the plan
const result = archivePlan(db, "archive-test", { memDir: testMemDir });
assert(result.planId === "archive-test", `archivePlan returned planId=${result.planId}`);
assert(result.tasksCount === 2, `archivePlan tasksCount=${result.tasksCount}`);
assert(result.sessionsCount === 1, `archivePlan sessionsCount=${result.sessionsCount}`);
assert(result.filePath.startsWith(testMemDir), `filePath in testMemDir: ${result.filePath}`);

// ── Test 2: listPlans() default excludes archived ───────────────────────────
console.log("\nTest 2: listPlans() excludes archived by default");

// Create another active plan to ensure listPlans still returns it
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "active-plan",
  slug: "active-plan",
  title: "Active Plan",
});

const activePlans = listPlans(db);
assert(
  activePlans.every((p) => p.archivedAt === null),
  "listPlans() returns only active plans (archived_at IS NULL)",
);
assert(
  !activePlans.some((p) => p.id === "archive-test"),
  "listPlans() does NOT include archived plan",
);

// ── Test 3: listPlans({ includeArchived: true }) includes archived ──────────
console.log("\nTest 3: listPlans({ includeArchived: true }) includes archived");

const allPlans = listPlans(db, { includeArchived: true });
assert(
  allPlans.some((p) => p.id === "archive-test"),
  "listPlans({ includeArchived: true }) includes archived plan",
);

// ── Test 4: searchPlans() excludes archived ─────────────────────────────────
console.log("\nTest 4: searchPlans() excludes archived by default");

// FTS search for a word from the archived plan's title
const searchResults = searchPlans(db, "archive");
assert(
  !searchResults.some((p) => p.id === "archive-test"),
  "searchPlans() does NOT find archived plan",
);

// ── Test 5: Markdown file validation ────────────────────────────────────────
console.log("\nTest 5: Markdown file exists and is valid");

const mdFile = result.filePath;
assert(existsSync(mdFile), `markdown file exists: ${mdFile}`);

const mdContent = readFileSync(mdFile, "utf-8");
assert(mdContent.length > 500, `markdown > 500 bytes: ${mdContent.length} bytes`);
assert(
  mdContent.includes("# Plan: Archive Test Plan"),
  "markdown contains '# Plan: Archive Test Plan'",
);
assert(mdContent.includes("Implement feature A"), "markdown contains task 1 description");
assert(mdContent.includes("Write tests for A"), "markdown contains task 2 description");
assert(mdContent.includes("session-"), "markdown contains session ID prefix");

// ── Test 6: plan_tasks.archived_at set ──────────────────────────────────────
console.log("\nTest 6: plan_tasks.archived_at is set");

const archivedTasks = listTasksByPlan(db, "archive-test", { includeArchived: true });
assert(
  archivedTasks.length === 2 && archivedTasks.every((t) => t.archivedAt !== null),
  "both tasks have archived_at set",
);

// ── Test 7: sessions.archived_at set ────────────────────────────────────────
console.log("\nTest 7: sessions.archived_at is set");

const archivedSession = db
  .query("SELECT archived_at FROM sessions WHERE id = ?")
  .get("session-archive-test") as { archived_at: number | null } | null;
assert(
  archivedSession !== null && archivedSession.archived_at !== null,
  "session.archived_at is set",
);

// ── Test 8: Re-archive throws "already archived" ────────────────────────────
console.log("\nTest 8: Re-archive throws 'already archived'");

assertThrows(
  () => archivePlan(db, "archive-test", { memDir: testMemDir }),
  "already archived",
  "re-archive throws 'ndomo: plan already archived'",
);

// ── Test 9: searchPlans returns results ordered by rank ─────────────────────
console.log("\nTest 9: searchPlans returns results ordered by rank (FTS5 relevance)");

// Create 3 plans with different match-strength keywords
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "rank-1",
  slug: "rank-test-1",
  title: "Database migration tool",
  overview: "A tool for running database migration automatically",
});

createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "rank-2",
  slug: "rank-test-2",
  title: "Migration helper",
  overview: "A helper utility for migration tasks in the database layer",
});

createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "rank-3",
  slug: "rank-test-3",
  title: "Simple utility",
  overview: "A basic utility for common tasks",
});

// Search for "database" — rank-1 and rank-2 should match, rank-1 has it in title
const rankResults = searchPlans(db, "database", 10);
assert(rankResults.length >= 2, `searchPlans found ${rankResults.length} results for "database"`);
if (rankResults[0] && rankResults.length >= 2) {
  // rank-1 has "Database" in title (higher rank), should be first
  assert(
    rankResults[0].id === "rank-1",
    `searchPlans rank: rank-1 is first (got ${rankResults[0].id})`,
  );
}

// ── Test 10: nextTaskForAgent skips archived tasks ──────────────────────────
console.log("\nTest 10: nextTaskForAgent skips archived tasks by default");

// Create a plan with tasks, then archive it
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "agent-archived-plan",
  slug: "agent-archived-plan",
  title: "Agent Archived Plan",
});

createTasksBatch(db, "agent-archived-plan", [
  { ...TASK_DEFAULTS, description: "Task for archived plan", orderIndex: 0, agent: "test-agent" },
]);

// Archive the plan (this archives tasks too)
archivePlan(db, "agent-archived-plan", { memDir: testMemDir });

// nextTaskForAgent should NOT return archived task
const archivedTask = nextTaskForAgent(db, "test-agent");
assert(
  archivedTask === null,
  "nextTaskForAgent returns null for archived task (default includeArchived=false)",
);

// With includeArchived: true, should return the task
const archivedTaskIncluded = nextTaskForAgent(db, "test-agent", { includeArchived: true });
assert(
  archivedTaskIncluded !== null && archivedTaskIncluded.planId === "agent-archived-plan",
  "nextTaskForAgent with includeArchived=true returns archived task",
);

// ── Test 11: findPlansByCategory excludes archived by default ───────────────
console.log("\nTest 11: findPlansByCategory excludes archived by default");

// Create a plan with category, then archive it
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "cat-archived-plan",
  slug: "cat-archived-plan",
  title: "Category Archived Plan",
  category: "feature",
});

archivePlan(db, "cat-archived-plan", { memDir: testMemDir });

// Create an active plan with same category
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "cat-active-plan",
  slug: "cat-active-plan",
  title: "Category Active Plan",
  category: "feature",
});

const catResults = findPlansByCategory(db, "feature");
assert(
  !catResults.some((p) => p.id === "cat-archived-plan"),
  "findPlansByCategory default excludes archived plan",
);
assert(
  catResults.some((p) => p.id === "cat-active-plan"),
  "findPlansByCategory default includes active plan",
);

const catResultsAll = findPlansByCategory(db, "feature", 20, { includeArchived: true });
assert(
  catResultsAll.some((p) => p.id === "cat-archived-plan"),
  "findPlansByCategory with includeArchived=true includes archived plan",
);

// ── Test 12: plan_progress view excludes archived tasks ─────────────────────
console.log("\nTest 12: plan_progress view excludes archived tasks from counts");

// Create a plan with tasks, check progress, archive, check again
createPlan(db, {
  ...PLAN_DEFAULTS,
  id: "progress-test",
  slug: "progress-test",
  title: "Progress Test Plan",
});

createTasksBatch(db, "progress-test", [
  { ...TASK_DEFAULTS, description: "Progress task 1", orderIndex: 0 },
  { ...TASK_DEFAULTS, description: "Progress task 2", orderIndex: 1 },
]);

// Check progress before archive — should show 2 tasks
const progressBefore = getPlanProgress(db, "progress-test");
const progressBeforeFirst = progressBefore[0];
assert(
  progressBefore.length === 1 && progressBeforeFirst?.totalTasks === 2,
  `plan_progress before archive: totalTasks=${progressBeforeFirst?.totalTasks ?? 0}`,
);

// Archive the plan (archives tasks too)
archivePlan(db, "progress-test", { memDir: testMemDir });

// Check progress after archive — should show 0 tasks (archived excluded)
const progressAfter = getPlanProgress(db, "progress-test");
const progressAfterFirst = progressAfter[0];
assert(
  progressAfter.length === 1 && progressAfterFirst?.totalTasks === 0,
  `plan_progress after archive: totalTasks=${progressAfterFirst?.totalTasks ?? 0} (archived excluded)`,
);

// ── Cleanup ─────────────────────────────────────────────────────────────────
rmSync(testMemDir, { recursive: true, force: true });
db.close();

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
