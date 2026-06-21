/**
 * ndomo smoke-hot — end-to-end DB feature test (v1-v5).
 *
 * Runs 7 numbered tests on a fresh DB. Exits 0 on all pass, 1 on any fail.
 * Uses HOME from env, creates $HOME/.ndomo/ for mem/plans archive.
 * NDOMO_MEM_DIR env var overrides mem dir (default ~/.ndomo/mem/plans).
 *
 * Usage:
 *   TESTHOME=$(mktemp -d) \
 *     HOME=$TESTHOME \
 *     NDOMO_MEM_DIR=$TESTHOME/.ndomo/mem/plans \
 *     bun scripts/smoke-hot.ts
 *
 * Cleanup:
 *   rm -rf $TESTHOME
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrations.ts";
import { archivePlan } from "../src/db/plan-archive.ts";
import { approvePlan, createPlan, searchPlans, updatePlanStatus } from "../src/db/plans.ts";
import { checkpointSession, getSession, startSession } from "../src/db/sessions.ts";
import { createTasksBatch, updateTaskStatus } from "../src/db/tasks.ts";

// ─── Setup ─────────────────────────────────────────────────────────────────

const home = process.env.HOME;
if (!home) {
  console.error("HOME not set");
  process.exit(1);
}

const testDir = join(home, ".ndomo-test");
mkdirSync(testDir, { recursive: true });

// Ensure $HOME/.ndomo/ exists (spec requirement)
mkdirSync(join(home, ".ndomo"), { recursive: true });

const db = openDb(testDir);
runMigrations(db);

let testN = 0;

function fail(n: number, msg: string, err?: unknown): never {
  console.error(`[${n}/7] ${msg}... FAILED`);
  if (err !== undefined) {
    console.error(err instanceof Error ? err.message : String(err));
  }
  console.error("SMOKE FAILED");
  db.close();
  process.exit(1);
}

// ─── Test 1: Migrations in fresh DB ────────────────────────────────────────

testN++;
try {
  const versions = db.query("SELECT version FROM schema_version ORDER BY version").all() as {
    version: number;
  }[];

  if (versions.length !== 5) {
    fail(testN, `schema_version has ${versions.length} entries, expected 5`, versions);
  }
  console.log(`[${testN}/7] schema_version has 5 entries (v1..v5)... OK`);
  console.log(JSON.stringify(versions, null, 2));

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
    .all() as { name: string }[];
  const tableNames = tables.map((r) => r.name);

  const expected = ["plans", "plan_tasks", "sessions", "plan_tags", "task_tags", "plan_progress"];
  for (const name of expected) {
    if (!tableNames.includes(name)) {
      fail(testN, `missing table/view: ${name}`, tableNames);
    }
  }
  console.log(`[${testN}/7] Required tables/views exist... OK`);
  console.log(JSON.stringify(tableNames, null, 2));
} catch (err) {
  fail(testN, "Migrations in fresh DB", err);
}

// ─── Test 2: createPlan (draft) ────────────────────────────────────────────

testN++;
try {
  const plan = createPlan(db, {
    id: "hp1",
    slug: "hot-test",
    title: "Hot Test",
    status: "draft",
    priority: 3,
    overview: "smoke hot",
    approvedAt: null,
    completedAt: null,
    sessionId: null,
    approach: null,
    complexity: 3,
    createdBy: "smoke",
    updatedBy: "smoke",
    sourceSessionId: null,
    sourceMessageId: null,
    category: null,
    metadata: {},
    archivedAt: null,
  });

  if (plan.status !== "draft") {
    fail(testN, `expected status "draft", got "${plan.status}"`, plan);
  }
  if (plan.id !== "hp1") {
    fail(testN, `expected id "hp1", got "${plan.id}"`, plan);
  }
  console.log(`[${testN}/7] createPlan (draft) id=hp1 status=draft... OK`);
  console.log(JSON.stringify({ id: plan.id, status: plan.status }, null, 2));
} catch (err) {
  fail(testN, "createPlan (draft)", err);
}

// ─── Test 3: approvePlan + createTasksBatch ────────────────────────────────

testN++;
try {
  const approved = approvePlan(db, "hp1");
  if (!approved) {
    fail(testN, "approvePlan returned null");
  }
  if (approved.status !== "approved") {
    fail(testN, `expected status "approved", got "${approved.status}"`, approved);
  }
  if (approved.approvedAt === null) {
    fail(testN, "approvedAt should not be null after approvePlan", approved);
  }
  console.log(`[${testN}/7] approvePlan status=approved approvedAt=set... OK`);

  const tasks = createTasksBatch(db, "hp1", [
    {
      orderIndex: 0,
      description: "task 1",
      agent: "smith",
      files: [],
      dependencies: [],
      complexity: 2,
      createdBy: "smoke",
      updatedBy: "smoke",
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
      description: "task 2",
      agent: "js-smith",
      files: [],
      dependencies: [],
      complexity: 3,
      createdBy: "smoke",
      updatedBy: "smoke",
      sourceSessionId: null,
      sourceMessageId: null,
      reviewedBy: null,
      tokensUsed: null,
      durationMs: null,
      artifacts: [],
      metadata: {},
    },
  ]);

  if (tasks.length !== 2) {
    fail(testN, `expected 2 tasks, got ${tasks.length}`, tasks);
  }
  if (tasks[0]?.orderIndex !== 0) {
    fail(testN, `task[0].orderIndex expected 0, got ${tasks[0]?.orderIndex}`, tasks[0]);
  }
  if (tasks[1]?.orderIndex !== 1) {
    fail(testN, `task[1].orderIndex expected 1, got ${tasks[1]?.orderIndex}`, tasks[1]);
  }
  console.log(`[${testN}/7] createTasksBatch 2 tasks orderIndex 0,1... OK`);
  console.log(
    JSON.stringify(
      tasks.map((t) => ({ id: t.id, orderIndex: t.orderIndex, description: t.description })),
      null,
      2,
    ),
  );
} catch (err) {
  fail(testN, "approvePlan + createTasksBatch", err);
}

// ─── Test 4: session + checkpoint + task updates ───────────────────────────

testN++;
try {
  const sessionStarted = startSession(db, {
    id: "hs1",
    planId: "hp1",
    goal: "smoke",
    metadata: {},
  });
  if (sessionStarted.id !== "hs1") {
    fail(testN, `startSession id mismatch: got "${sessionStarted.id}"`);
  }
  console.log(`[${testN}/7] startSession id=hs1... OK`);

  const sessionCheckpointed = checkpointSession(
    db,
    "hs1",
    { phase: "testing" },
    "chose smoke path",
  );
  if (!sessionCheckpointed) {
    fail(testN, "checkpointSession returned null");
  }
  if (sessionCheckpointed.state.phase !== "testing") {
    fail(
      testN,
      `expected state.phase "testing", got "${String(sessionCheckpointed.state.phase)}"`,
      sessionCheckpointed.state,
    );
  }
  if (sessionCheckpointed.keyDecisions !== "chose smoke path") {
    fail(
      testN,
      `expected keyDecisions "chose smoke path", got "${sessionCheckpointed.keyDecisions}"`,
    );
  }
  console.log(`[${testN}/7] checkpointSession phase=testing keyDecisions=set... OK`);

  // Get tasks for this plan via direct query (avoids import cycle)
  const tasks = (
    db
      .query("SELECT id, order_index FROM plan_tasks WHERE plan_id = ? ORDER BY order_index")
      .all("hp1") as { id: string; order_index: number }[]
  ).map((r) => ({ id: r.id, orderIndex: r.order_index }));

  if (tasks.length < 2) {
    fail(testN, `expected at least 2 tasks, got ${tasks.length}`, tasks);
  }
  const t0 = tasks[0] as { id: string };
  const t1 = tasks[1] as { id: string };

  // Set task 0 to running
  const runningTask = updateTaskStatus(db, t0.id, "running");
  if (!runningTask || runningTask.status !== "running") {
    fail(testN, `task[0] status expected "running", got "${runningTask?.status}"`);
  }
  if (runningTask.startedAt === null) {
    fail(testN, "task[0].startedAt should be set after running status", runningTask);
  }
  console.log(`[${testN}/7] task[0] status=running startedAt=set... OK`);

  // Set task 0 to done with result
  const doneTask0 = updateTaskStatus(db, t0.id, "done", {
    result: "completed successfully",
  });
  if (!doneTask0 || doneTask0.status !== "done") {
    fail(testN, `task[0] status expected "done", got "${doneTask0?.status}"`);
  }
  if (doneTask0.completedAt === null) {
    fail(testN, "task[0].completedAt should be set after done status", doneTask0);
  }
  console.log(`[${testN}/7] task[0] status=done completedAt=set... OK`);

  // Set task 1 to done with result
  const doneTask1 = updateTaskStatus(db, t1.id, "done", { result: "ok" });
  if (!doneTask1 || doneTask1.status !== "done") {
    fail(testN, `task[1] status expected "done", got "${doneTask1?.status}"`);
  }
  console.log(`[${testN}/7] task[1] status=done... OK`);

  // Verify session state persisted
  const sessionReloaded = getSession(db, "hs1");
  if (!sessionReloaded) {
    fail(testN, "getSession returned null after updates");
  }
  if (sessionReloaded.state.phase !== "testing") {
    fail(testN, "session.state.phase should persist after checkpoint", sessionReloaded.state);
  }
  console.log(`[${testN}/7] session state persisted phase=testing... OK`);
} catch (err) {
  fail(testN, "session + checkpoint + task updates", err);
}

// ─── Test 5: updatePlanStatus(completed) + auto-archive ────────────────────

testN++;
try {
  const updated = updatePlanStatus(db, "hp1", "completed");
  if (!updated || updated.status !== "completed") {
    fail(testN, `updatePlanStatus expected "completed", got "${updated?.status}"`);
  }
  console.log(`[${testN}/7] updatePlanStatus(completed)... OK`);

  // Replicate auto-archive logic from plugin.ts
  // getMemDir equivalent: NDOMO_MEM_DIR env var, else ~/.ndomo/mem/plans
  const localMemDir = process.env.NDOMO_MEM_DIR ?? join(home, ".ndomo", "mem", "plans");
  mkdirSync(localMemDir, { recursive: true });

  const archiveResult = archivePlan(db, "hp1", { memDir: localMemDir });

  if (!existsSync(archiveResult.filePath)) {
    fail(testN, `archive file not found at ${archiveResult.filePath}`, archiveResult);
  }
  console.log(`[${testN}/7] archive file exists... OK`);
  console.log(
    JSON.stringify({ filePath: archiveResult.filePath, byteSize: archiveResult.byteSize }, null, 2),
  );

  const mdContent = readFileSync(archiveResult.filePath, "utf-8");
  if (!mdContent.includes("Hot Test")) {
    fail(testN, "archive markdown missing 'Hot Test'", { preview: mdContent.slice(0, 200) });
  }
  if (!mdContent.includes("## Tasks")) {
    fail(testN, "archive markdown missing '## Tasks' section", {
      preview: mdContent.slice(0, 500),
    });
  }
  console.log(`[${testN}/7] markdown includes "Hot Test" and "## Tasks"... OK`);
} catch (err) {
  fail(testN, "updatePlanStatus + auto-archive", err);
}

// ─── Test 6: searchPlans filters archived by default ───────────────────────

testN++;
try {
  const defaultResults = searchPlans(db, "hot test");
  if (defaultResults.length !== 0) {
    fail(
      testN,
      `searchPlans() expected 0 results, got ${defaultResults.length}`,
      defaultResults.map((p) => ({ id: p.id, title: p.title })),
    );
  }
  console.log(`[${testN}/7] searchPlans() returns 0 (archived excluded)... OK`);

  const archivedResults = searchPlans(db, "hot test", 20, {
    includeArchived: true,
  });
  if (archivedResults.length !== 1) {
    fail(
      testN,
      `searchPlans(includeArchived:true) expected 1 result, got ${archivedResults.length}`,
      archivedResults.map((p) => ({ id: p.id, title: p.title })),
    );
  }
  if (archivedResults[0]?.id !== "hp1") {
    fail(testN, `expected hp1, got ${archivedResults[0]?.id}`, archivedResults[0]);
  }
  console.log(`[${testN}/7] searchPlans(includeArchived:true) returns hp1... OK`);
  console.log(
    JSON.stringify(
      archivedResults.map((p) => ({ id: p.id, title: p.title })),
      null,
      2,
    ),
  );
} catch (err) {
  fail(testN, "searchPlans archive filter", err);
}

// ─── Test 7: verify archive markdown format ────────────────────────────────

testN++;
try {
  const localMemDir = process.env.NDOMO_MEM_DIR ?? join(home, ".ndomo", "mem", "plans");
  // Find the md file for hp1 (hot-test-2026-*.md)
  const files = readdirSync(localMemDir).filter(
    (f) => f.startsWith("hot-test-") && f.endsWith(".md"),
  );
  if (files.length === 0) {
    fail(testN, "no archive markdown file found in memDir", localMemDir);
  }
  const firstFile = files[0] as string;
  const mdPath = join(localMemDir, firstFile);
  const mdContent = readFileSync(mdPath, "utf-8");
  const lines = mdContent.split("\n");

  // First line should be # Plan: Hot Test
  const firstLine = lines[0] ?? "";
  if (!firstLine.includes("Hot Test")) {
    fail(testN, `first line should contain "Hot Test", got: "${firstLine}"`);
  }
  console.log(`[${testN}/7] first line contains "Hot Test"... OK`);

  // Section ## Tasks with 2 [x] checkboxes
  const taskCheckboxMatches = mdContent.match(/\[x\]/g);
  if (!taskCheckboxMatches || taskCheckboxMatches.length < 2) {
    fail(testN, `expected 2 [x] checkboxes, found ${taskCheckboxMatches?.length ?? 0}`);
  }
  console.log(`[${testN}/7] has ## Tasks with 2 [x] checkboxes... OK`);

  // Section ## Metadata with JSON block
  if (!mdContent.includes("## Metadata")) {
    fail(testN, "missing ## Metadata section", { preview: mdContent.slice(-500) });
  }
  if (!mdContent.includes("```json")) {
    fail(testN, "missing JSON code block in Metadata", { preview: mdContent.slice(-500) });
  }
  console.log(`[${testN}/7] has ## Metadata with JSON block... OK`);
} catch (err) {
  fail(testN, "archive markdown format check", err);
}

// ─── Done ──────────────────────────────────────────────────────────────────

db.close();
console.log("SMOKE OK");
process.exit(0);
