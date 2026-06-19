/**
 * ndomo v5 E2E stress test — full plan lifecycle post-hotfix.
 *
 * Verifies FTS5 correctness (the critical v4→v5 bug), archive lifecycle,
 * migration idempotency, and edge cases.
 *
 * Stack: TS + Bun + bun:sqlite. NO code modifications — read + execute only.
 *
 * Usage: bun run scripts/smoke-e2e.ts
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/db/migrations.ts";
import { archivePlan } from "../src/db/plan-archive.ts";
import {
  addPlanTag,
  approvePlan,
  createPlan,
  findPlansByCategory,
  findPlansByTag,
  getPlan,
  getPlanProgress,
  listPlans,
  searchPlans,
  updatePlanStatus,
} from "../src/db/plans.ts";
import { checkpointSession, startSession } from "../src/db/sessions.ts";
import {
  createTasksBatch,
  nextTaskForAgent,
  searchTasks,
  updateTaskStatus,
} from "../src/db/tasks.ts";
import type { Plan, PlanCategory } from "../src/db/types.ts";

// ── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: Array<{ test: string; msg: string }> = [];

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push({ test: "current", msg });
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertThrows(fn: () => void, expectedMsg: string, msg: string): void {
  try {
    fn();
    fail++;
    failures.push({ test: "current", msg: `${msg} (expected error, got none)` });
    console.error(`  ✗ FAIL: ${msg} (expected error, got none)`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes(expectedMsg)) {
      pass++;
      console.log(`  ✓ ${msg}`);
    } else {
      fail++;
      failures.push({
        test: "current",
        msg: `${msg} (expected '${expectedMsg}', got '${errMsg}')`,
      });
      console.error(`  ✗ FAIL: ${msg} (expected '${expectedMsg}', got '${errMsg}')`);
    }
  }
}

function section(name: string): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${name}`);
  console.log(`${"─".repeat(60)}`);
}

// ── Defaults ─────────────────────────────────────────────────────────────────

const PLAN_DEFAULTS = {
  status: "draft" as const,
  priority: 3,
  overview: "smoke test plan overview for validation",
  complexity: 3,
  createdBy: "smoke-e2e",
  updatedBy: "smoke-e2e",
  metadata: {},
  approvedAt: null,
  completedAt: null,
  sessionId: null,
  approach: "Test approach for E2E smoke validation",
  sourceSessionId: null,
  sourceMessageId: null,
  category: null as Plan["category"],
  archivedAt: null,
};

const TASK_DEFAULTS = {
  agent: "smith",
  files: [] as string[],
  complexity: 3,
  createdBy: "smoke-e2e",
  updatedBy: "smoke-e2e",
  sourceSessionId: null,
  sourceMessageId: null,
  reviewedBy: null,
  tokensUsed: null,
  durationMs: null,
  artifacts: [] as string[],
  dependencies: [] as string[],
  metadata: {},
};

function mkPlan(
  id: string,
  slug: string,
  title: string,
  overrides?: Partial<typeof PLAN_DEFAULTS>,
) {
  return createPlan(db, { ...PLAN_DEFAULTS, id, slug, title, ...overrides });
}

// ── Main ─────────────────────────────────────────────────────────────────────

const db = new Database(":memory:");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const testMemDir = join(tmpdir(), `ndomo-smoke-e2e-${Date.now()}`);
mkdirSync(testMemDir, { recursive: true });

console.log("ndomo v5 E2E stress test\n");

// ── Run migrations v1→v5 ────────────────────────────────────────────────────
console.log("Running migrations v1→v5...");
runMigrations(db);
const ver = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
assert(ver.v === 5, `schema_version = 5 (got ${ver.v})`);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 1: FTS5 positivo (CRÍTICO — antes broken por content='')
// ═════════════════════════════════════════════════════════════════════════════
section("Test 1: FTS5 positivo — searchPlans con keywords diferentes");

mkPlan("fts-auth", "fts-auth", "Authentication bug in login flow");
mkPlan("fts-authz", "fts-authz", "Authorization refactor for role-based access");
mkPlan("fts-perf", "fts-perf", "Performance optimization for database queries");

const r1 = searchPlans(db, "authentication");
assert(r1.length === 1, `searchPlans("authentication") → 1 result (got ${r1.length})`);
assert(r1[0]?.id === "fts-auth", `searchPlans("authentication") → fts-auth (got ${r1[0]?.id})`);

const r2 = searchPlans(db, "access");
assert(r2.length === 1, `searchPlans("access") → 1 result (got ${r2.length})`);
assert(r2[0]?.id === "fts-authz", `searchPlans("access") → fts-authz (got ${r2[0]?.id})`);

const r3 = searchPlans(db, "optimization");
assert(r3.length === 1, `searchPlans("optimization") → 1 result (got ${r3.length})`);
assert(r3[0]?.id === "fts-perf", `searchPlans("optimization") → fts-perf (got ${r3[0]?.id})`);

// BUG-1 FIX: FTS5 MATCH no longer throws on hyphens — escapeFtsQuery wraps input in "..."
// searchPlans("nonexistent-xyz") should return 0 results, NOT throw SQLiteError
const rHyphen = searchPlans(db, "nonexistent-xyz");
assert(
  rHyphen.length === 0,
  `searchPlans("nonexistent-xyz") → [] (no throw, hyphen safe) (got ${rHyphen.length})`,
);

// Use safe search term (no hyphens) for the actual empty-results assertion
const rEmpty = searchPlans(db, "nonexistentxyz12345");
assert(rEmpty.length === 0, `searchPlans("nonexistentxyz12345") → [] (got ${rEmpty.length})`);

// Multi-match: "user" appears in both titles
mkPlan("fts-login", "fts-login", "user login authentication flow");
mkPlan("fts-logout", "fts-logout", "user logout cleanup handler");
const rMulti = searchPlans(db, "user");
assert(rMulti.length === 2, `searchPlans("user") → 2 results (got ${rMulti.length})`);
const multiIds = rMulti.map((p) => p.id).sort();
assert(
  multiIds.includes("fts-login") && multiIds.includes("fts-logout"),
  `searchPlans("user") includes fts-login and fts-logout (got [${multiIds.join(", ")}])`,
);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2: FTS5 con acentos (remove_diacritics)
// ═════════════════════════════════════════════════════════════════════════════
section("Test 2: FTS5 con acentos — remove_diacritics");

mkPlan("fts-acc", "fts-acc", "Plan de Acción correctiva");

const rAcc1 = searchPlans(db, "accion");
assert(rAcc1.length === 1, `searchPlans("accion") finds "Acción" (got ${rAcc1.length})`);
assert(rAcc1[0]?.id === "fts-acc", `searchPlans("accion") → fts-acc (got ${rAcc1[0]?.id})`);

const rAcc2 = searchPlans(db, "acción");
assert(rAcc2.length === 1, `searchPlans("acción") finds "Acción" (got ${rAcc2.length})`);
assert(rAcc2[0]?.id === "fts-acc", `searchPlans("acción") → fts-acc (got ${rAcc2[0]?.id})`);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 2b: BUG-1 fix — escapeFtsQuery validation
// ═════════════════════════════════════════════════════════════════════════════
section("Test 2b: BUG-1 fix — hyphens, quotes, diacritics via escapeFtsQuery");

// Hyphenated phrase: "auth-bug" treated as literal phrase, not column qualifier
mkPlan("fts-hyphen", "fts-hyphen", "Fix auth-bug in login module");
const rHyphenSearch = searchPlans(db, "auth-bug");
assert(
  rHyphenSearch.length === 1,
  `searchPlans("auth-bug") → 1 result (got ${rHyphenSearch.length})`,
);
assert(
  rHyphenSearch[0]?.id === "fts-hyphen",
  `searchPlans("auth-bug") → fts-hyphen (got ${rHyphenSearch[0]?.id})`,
);

// Internal quotes: must be escaped, not throw
mkPlan("fts-quotes", "fts-quotes", 'Plan with "quotes" in title');
const rQuotes = searchPlans(db, 'term with "quotes"');
assert(
  rQuotes.length === 0,
  `searchPlans('term with "quotes"') → 0 results, no throw (got ${rQuotes.length})`,
);

// Diacritics with explicit "Accion" plan (confirm accent-insensitive search)
mkPlan("fts-accion", "fts-accion", "Accion correctiva urgente");
const rAccion = searchPlans(db, "acción");
assert(
  rAccion.some((p) => p.id === "fts-accion"),
  `searchPlans("acción") finds "Accion" plan (fts-accion)`,
);

// searchTasks with hyphens: also uses escapeFtsQuery
createTasksBatch(db, "fts-hyphen", [
  { ...TASK_DEFAULTS, description: "Fix auth-bug in API endpoint", orderIndex: 0 },
]);
const rTaskHyphen = searchTasks(db, "auth-bug");
assert(rTaskHyphen.length >= 1, `searchTasks("auth-bug") → ≥1 result (got ${rTaskHyphen.length})`);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 3: FTS5 stopwords
// ═════════════════════════════════════════════════════════════════════════════
section("Test 3: FTS5 stopwords — 'el' es stopword español");

mkPlan("fts-stop", "fts-stop", "El plan para hacer algo importante");

// "el" is a Spanish stopword in the fts5_stopwords table, BUT the FTS5 tokenizer
// (unicode61 remove_diacritics 1) does NOT reference that custom stopwords table.
// unicode61 default stopword list does not include Spanish words.
// Spec says "[] o muy pocos" — we document this as a finding and accept ≤1.
const rStop = searchPlans(db, "el");
if (rStop.length > 0) {
  console.log(
    "  ⚠ FINDING: searchPlans('el') returned results — fts5_stopwords table not wired to FTS5 tokenizer",
  );
  console.log(
    "    → unicode61 remove_diacritics 1 does NOT use custom stopwords. Spanish stopwords are decorative.",
  );
}
assert(
  rStop.length <= 1,
  `searchPlans("el") → [] o muy pocos (got ${rStop.length}, spec allows ≤1)`,
);

// "plan" is NOT a stopword → should find it
const rPlan = searchPlans(db, "plan");
assert(rPlan.length >= 1, `searchPlans("plan") finds the plan (got ${rPlan.length})`);
assert(
  rPlan.some((p) => p.id === "fts-stop"),
  `searchPlans("plan") includes fts-stop`,
);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 4: Plan lifecycle completo
// ═════════════════════════════════════════════════════════════════════════════
section(
  "Test 4: Plan lifecycle completo — create → approve → tasks → session → complete → archive",
);

// 4.1 Create plan (status=draft)
const lifecyclePlan = mkPlan("lc-plan", "lifecycle-test", "Full Lifecycle Test Plan");
assert(
  lifecyclePlan.status === "draft",
  `plan created with status=draft (got ${lifecyclePlan.status})`,
);

// 4.2 Approve plan
const approvedPlan = approvePlan(db, "lc-plan", { updatedBy: "smoke-e2e" });
assert(approvedPlan !== null, "approvePlan returned plan");
assert(approvedPlan?.status === "approved", `plan approved (got ${approvedPlan?.status})`);
assert(approvedPlan?.approvedAt !== null, "approved_at is set");

// 4.3 Create 3 tasks
const lcTasks = createTasksBatch(db, "lc-plan", [
  { ...TASK_DEFAULTS, description: "Implement authentication module", orderIndex: 0 },
  { ...TASK_DEFAULTS, description: "Write unit tests", orderIndex: 1 },
  { ...TASK_DEFAULTS, description: "Update documentation", orderIndex: 2 },
]);
assert(lcTasks.length === 3, `created 3 tasks (got ${lcTasks.length})`);

// 4.4 Start session
const lcSession = startSession(db, {
  id: "lc-session-1",
  goal: "Complete lifecycle test plan",
  planId: "lc-plan",
});
assert(lcSession.planId === "lc-plan", `session linked to plan (got ${lcSession.planId})`);

// 4.5 Task 1: pending → running
assert(lcTasks[0] !== undefined, "task 0 exists");
assert(lcTasks[1] !== undefined, "task 1 exists");
assert(lcTasks[2] !== undefined, "task 2 exists");
const t1 = lcTasks[0] as NonNullable<(typeof lcTasks)[number]>;
updateTaskStatus(db, t1.id, "running");
const t1Running = db.query("SELECT status FROM plan_tasks WHERE id = ?").get(t1.id) as {
  status: string;
} | null;
assert(t1Running?.status === "running", `task 1 → running (got ${t1Running?.status})`);

// 4.6 Task 1: running → done
updateTaskStatus(db, t1.id, "done", { result: "Authentication module implemented" });
const t1Done = db.query("SELECT status FROM plan_tasks WHERE id = ?").get(t1.id) as {
  status: string;
} | null;
assert(t1Done?.status === "done", `task 1 → done (got ${t1Done?.status})`);

// 4.7 Task 2: pending → done
const t2 = lcTasks[1] as NonNullable<(typeof lcTasks)[number]>;
updateTaskStatus(db, t2.id, "done", { result: "All tests passing" });

// 4.8 Task 3: pending → done
const t3 = lcTasks[2] as NonNullable<(typeof lcTasks)[number]>;
updateTaskStatus(db, t3.id, "done", { result: "Docs updated" });

// 4.9 Session checkpoint
const checkpoint = checkpointSession(
  db,
  "lc-session-1",
  { tasksCompleted: 3, totalTasks: 3 },
  "All tasks completed successfully",
);
assert(checkpoint !== null, "session checkpoint succeeded");

// 4.10 Plan → completed
const completedPlan = updatePlanStatus(db, "lc-plan", "completed", { updatedBy: "smoke-e2e" });
assert(completedPlan?.status === "completed", `plan → completed (got ${completedPlan?.status})`);

// 4.11 Archive the plan
const archiveResult = archivePlan(db, "lc-plan", { memDir: testMemDir });
assert(archiveResult.planId === "lc-plan", "archivePlan planId=lc-plan");
assert(
  archiveResult.tasksCount === 3,
  `archivePlan tasksCount=3 (got ${archiveResult.tasksCount})`,
);
assert(
  archiveResult.sessionsCount === 1,
  `archivePlan sessionsCount=1 (got ${archiveResult.sessionsCount})`,
);

// 4.12 Verify archived_at set on plan, tasks, sessions
const archivedPlan = getPlan(db, "lc-plan");
assert(archivedPlan?.archivedAt !== null, "plan.archived_at is set");

const archivedTasks = db
  .query(
    "SELECT COUNT(*) as c FROM plan_tasks WHERE plan_id = 'lc-plan' AND archived_at IS NOT NULL",
  )
  .get() as { c: number };
assert(archivedTasks.c === 3, `3 tasks have archived_at set (got ${archivedTasks.c})`);

const archivedSession = db
  .query("SELECT archived_at FROM sessions WHERE id = 'lc-session-1'")
  .get() as { archived_at: number | null } | null;
assert(archivedSession?.archived_at !== null, "session.archived_at is set");

// 4.13 listPlans() default excludes archived
const activeOnly = listPlans(db);
assert(!activeOnly.some((p) => p.id === "lc-plan"), "listPlans() excludes archived plan");

// 4.14 listPlans({ includeArchived: true }) includes archived
const withArchived = listPlans(db, { includeArchived: true });
assert(
  withArchived.some((p) => p.id === "lc-plan"),
  "listPlans({ includeArchived: true }) includes archived plan",
);

// 4.15 Memory file exists and is valid
assert(existsSync(archiveResult.filePath), `memory file exists: ${archiveResult.filePath}`);
const mdContent = readFileSync(archiveResult.filePath, "utf-8");
assert(mdContent.length > 500, `markdown > 500 bytes (got ${mdContent.length})`);
assert(mdContent.includes("# Plan:"), "markdown contains '# Plan:'");
assert(mdContent.includes("## Tasks"), "markdown contains '## Tasks'");
assert(mdContent.includes("## Sessions"), "markdown contains '## Sessions'");
assert(mdContent.includes("## Metadata"), "markdown contains '## Metadata'");

// ═════════════════════════════════════════════════════════════════════════════
// TEST 5: Auto-archive no rompe flow
// ═════════════════════════════════════════════════════════════════════════════
section("Test 5: Auto-archive no rompe flow");

mkPlan("aa-plan", "test-no-archive", "Auto Archive Test Plan");
const aaResult = archivePlan(db, "aa-plan", { memDir: testMemDir });
assert(
  typeof aaResult.filePath === "string" && aaResult.filePath.length > 0,
  `archived.filePath is set: ${aaResult.filePath}`,
);
assert(existsSync(aaResult.filePath), "archived file exists on disk");

// Verify planUpdateStatus returns updated plan for already-completed scenario
mkPlan("aa-plan2", "test-no-archive-2", "Auto Archive Test Plan 2");
updatePlanStatus(db, "aa-plan2", "completed", { updatedBy: "smoke-e2e" });
const aa2Plan = getPlan(db, "aa-plan2");
assert(
  aa2Plan?.status === "completed",
  `planUpdateStatus returned completed plan (got ${aa2Plan?.status})`,
);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 6: Idempotencia del archive
// ═════════════════════════════════════════════════════════════════════════════
section("Test 6: Idempotencia del archive");

// 6.1 Re-archive already archived plan → throws "already archived"
assertThrows(
  () => archivePlan(db, "lc-plan", { memDir: testMemDir }),
  "already archived",
  "archivePlan on already-archived plan throws 'already archived'",
);

// 6.2 updatePlanStatus on archived plan → should work (not restrictive)
const updatedArchived = updatePlanStatus(db, "lc-plan", "failed", { updatedBy: "smoke-e2e" });
assert(updatedArchived !== null, "updatePlanStatus on archived plan returns plan");
assert(
  updatedArchived?.status === "failed",
  `archived plan status → failed (got ${updatedArchived?.status})`,
);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 7: nextTaskForAgent con archived
// ═════════════════════════════════════════════════════════════════════════════
section("Test 7: nextTaskForAgent con archived filter");

mkPlan("agent-plan", "agent-plan-test", "Agent Plan for nextTask Test");
createTasksBatch(db, "agent-plan", [
  { ...TASK_DEFAULTS, description: "Agent task 1", orderIndex: 0, agent: "smith" },
  { ...TASK_DEFAULTS, description: "Agent task 2", orderIndex: 1, agent: "smith" },
]);

// Archive the plan (auto-archives tasks)
archivePlan(db, "agent-plan", { memDir: testMemDir });

// Default: should NOT return tasks from archived plan
const archivedAgentTask = nextTaskForAgent(db, "smith", { planId: "agent-plan" });
assert(
  archivedAgentTask === null,
  `nextTaskForAgent default skips archived plan tasks (got ${archivedAgentTask?.id ?? "null"})`,
);

// With includeArchived: true → should return pending task
const includedTask = nextTaskForAgent(db, "smith", { planId: "agent-plan", includeArchived: true });
assert(
  includedTask !== null && includedTask.planId === "agent-plan",
  `nextTaskForAgent with includeArchived=true returns task (got ${includedTask?.id ?? "null"})`,
);
assert(
  includedTask?.status === "pending",
  `returned task status=pending (got ${includedTask?.status})`,
);

// ═════════════════════════════════════════════════════════════════════════════
// TEST 8: Migration upgrade path
// ═════════════════════════════════════════════════════════════════════════════
section("Test 8: Migration upgrade path — archived_at columns exist");

const db8 = new Database(":memory:");
db8.exec("PRAGMA journal_mode = WAL");
db8.exec("PRAGMA foreign_keys = ON");
runMigrations(db8);

// Verify archived_at exists on all 3 tables
for (const table of ["plans", "plan_tasks", "sessions"]) {
  const cols = db8.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  assert(
    cols.some((c) => c.name === "archived_at"),
    `${table}.archived_at column exists`,
  );
}

// Verify indexes exist
const indexes = db8
  .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%archived%'")
  .all() as Array<{ name: string }>;
assert(indexes.length === 3, `3 archived indexes exist (got ${indexes.length})`);

db8.close();

// ═════════════════════════════════════════════════════════════════════════════
// TEST 9: Re-run de migrations (idempotencia)
// ═════════════════════════════════════════════════════════════════════════════
section("Test 9: Re-run de migrations — idempotencia");

const db9 = new Database(":memory:");
db9.exec("PRAGMA journal_mode = WAL");
db9.exec("PRAGMA foreign_keys = ON");

// First run
runMigrations(db9);
const ver9a = db9.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number };
assert(ver9a.v === 5, `first run: schema_version = 5 (got ${ver9a.v})`);

// Second run — should not fail
let rerunFailed = false;
try {
  runMigrations(db9);
} catch (err) {
  rerunFailed = true;
  console.error(`  ✗ runMigrations() re-run threw: ${err}`);
}
assert(!rerunFailed, "runMigrations() re-run did not throw");

// Verify no duplicate schema_version rows
const versionRows = db9
  .query("SELECT version, COUNT(*) as c FROM schema_version GROUP BY version HAVING c > 1")
  .all();
assert(versionRows.length === 0, "no duplicate schema_version rows");

// Verify no duplicate indexes
const idxCount = db9
  .query(
    "SELECT name, COUNT(*) as c FROM sqlite_master WHERE type='index' GROUP BY name HAVING c > 1",
  )
  .all();
assert(idxCount.length === 0, "no duplicate indexes");

// Verify FTS table still works after re-run (use createPlan with db9 directly)
createPlan(db9, {
  ...PLAN_DEFAULTS,
  id: "rerun-test",
  slug: "rerun-test",
  title: "Rerun Test Plan for FTS validation",
});
const rerunSearch = searchPlans(db9, "rerun");
assert(
  rerunSearch.length === 1,
  `post-rerun: searchPlans("rerun") → 1 (got ${rerunSearch.length})`,
);

db9.close();

// ═════════════════════════════════════════════════════════════════════════════
// TEST 10: FTS5 cleanup post-archive
// ═════════════════════════════════════════════════════════════════════════════
section("Test 10: FTS5 cleanup post-archive — archived plans excluded from search");

mkPlan("fts-archive", "fts-archive-marker", "ZZZmarkerxyz unique title");

// Verify it's findable before archive
const preArchive = searchPlans(db, "ZZZmarkerxyz");
assert(
  preArchive.length === 1,
  `pre-archive: searchPlans("ZZZmarkerxyz") → 1 (got ${preArchive.length})`,
);

// Archive it
archivePlan(db, "fts-archive", { memDir: testMemDir });

// listPlans() default should NOT include it
const postArchiveList = listPlans(db);
assert(
  !postArchiveList.some((p) => p.id === "fts-archive"),
  "post-archive: listPlans() excludes archived plan",
);

// searchPlans() default should NOT find it (archived filter in JOIN)
const postArchiveSearch = searchPlans(db, "ZZZmarkerxyz");
assert(
  postArchiveSearch.length === 0,
  `post-archive: searchPlans("ZZZmarkerxyz") default → 0 (got ${postArchiveSearch.length})`,
);

// searchPlans with includeArchived: true SHOULD find it
const postArchiveSearchAll = searchPlans(db, "ZZZmarkerxyz", 20, { includeArchived: true });
assert(
  postArchiveSearchAll.length === 1,
  `post-archive: searchPlans("ZZZmarkerxyz", includeArchived=true) → 1 (got ${postArchiveSearchAll.length})`,
);
assert(
  postArchiveSearchAll[0]?.id === "fts-archive",
  `includeArchived search returns fts-archive (got ${postArchiveSearchAll[0]?.id})`,
);

// ═════════════════════════════════════════════════════════════════════════════
// BONUS: findPlansByTag with archived filter
// ═════════════════════════════════════════════════════════════════════════════
section("Bonus: findPlansByTag with archived filter");

mkPlan("tag-plan", "tag-plan-test", "Tag Test Plan");
addPlanTag(db, "tag-plan", "urgent", "smoke-e2e");

// Verify tag search works
const tagResults = findPlansByTag(db, "urgent");
assert(
  tagResults.some((p) => p.id === "tag-plan"),
  "findPlansByTag finds tagged plan",
);

// Archive and verify filter
archivePlan(db, "tag-plan", { memDir: testMemDir });

const tagAfterArchive = findPlansByTag(db, "urgent");
assert(
  !tagAfterArchive.some((p) => p.id === "tag-plan"),
  "findPlansByTag excludes archived plan by default",
);

const tagWithArchived = findPlansByTag(db, "urgent", 20, { includeArchived: true });
assert(
  tagWithArchived.some((p) => p.id === "tag-plan"),
  "findPlansByTag with includeArchived=true includes archived plan",
);

// ═════════════════════════════════════════════════════════════════════════════
// BONUS: findPlansByCategory with archived filter
// ═════════════════════════════════════════════════════════════════════════════
section("Bonus: findPlansByCategory with archived filter");

mkPlan("cat-plan", "cat-plan-test", "Category Test Plan", { category: "bugfix" as PlanCategory });
archivePlan(db, "cat-plan", { memDir: testMemDir });

const catResults = findPlansByCategory(db, "bugfix");
assert(
  !catResults.some((p) => p.id === "cat-plan"),
  "findPlansByCategory excludes archived plan by default",
);

const catWithArchived = findPlansByCategory(db, "bugfix", 20, { includeArchived: true });
assert(
  catWithArchived.some((p) => p.id === "cat-plan"),
  "findPlansByCategory with includeArchived=true includes archived plan",
);

// ═════════════════════════════════════════════════════════════════════════════
// BONUS: plan_progress view with archived filter
// ═════════════════════════════════════════════════════════════════════════════
section("Bonus: plan_progress view — archived tasks excluded from counts");

mkPlan("prog-plan", "prog-plan-test", "Progress Test Plan");
createTasksBatch(db, "prog-plan", [
  { ...TASK_DEFAULTS, description: "Progress task 1", orderIndex: 0 },
  { ...TASK_DEFAULTS, description: "Progress task 2", orderIndex: 1 },
]);

const progBefore = getPlanProgress(db, "prog-plan");
assert(progBefore.length === 1, "plan_progress returns 1 row");
assert(
  progBefore[0]?.totalTasks === 2,
  `before archive: totalTasks=2 (got ${progBefore[0]?.totalTasks})`,
);

archivePlan(db, "prog-plan", { memDir: testMemDir });

const progAfter = getPlanProgress(db, "prog-plan");
assert(progAfter.length === 1, "plan_progress still returns 1 row after archive");
assert(
  progAfter[0]?.totalTasks === 0,
  `after archive: totalTasks=0 (archived excluded, got ${progAfter[0]?.totalTasks})`,
);

// ═════════════════════════════════════════════════════════════════════════════
// Cleanup
// ═════════════════════════════════════════════════════════════════════════════
rmSync(testMemDir, { recursive: true, force: true });
db.close();

// ═════════════════════════════════════════════════════════════════════════════
// Reporte (caveman)
// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n${"═".repeat(60)}`);
console.log("  REPORTE E2E SMOKE TEST");
console.log(`${"═".repeat(60)}`);
console.log(`Total asserts: ${pass} pass / ${fail} fail`);
console.log(`Total tests: ${pass + fail}`);

if (fail > 0) {
  console.log("\nFALLOS:");
  for (const f of failures) {
    console.log(`  ✗ ${f.test}: ${f.msg}`);
  }
  console.log("\nANÁLISIS DE CAUSA RAÍZ:");
  console.log(`  Revisar los ${fail} fallos arriba. Cada uno indica:`);
  console.log("  - file:line → scripts/smoke-e2e.ts");
  console.log("  - error exacto → ver mensaje de fallo");
  console.log("  - causa raíz → probablemente FTS5 config, archive filter, o migration issue");
} else {
  console.log("\n✅ TODOS LOS TESTS PASARON - v5 hotfix validado end-to-end");
}

console.log(`${"═".repeat(60)}`);
process.exit(fail > 0 ? 1 : 0);
