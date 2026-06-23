import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { BackgroundDispatcher } from "./background.ts";

/** UUID v4 regex: 8-4-4-4-12 hex chars. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

describe("BackgroundDispatcher", () => {
  let db: Database;
  let dispatcher: BackgroundDispatcher;

  beforeEach(() => {
    db = createTestDb();
    dispatcher = new BackgroundDispatcher(db);
  });

  // 1. dispatch returns a UUID v4
  test("dispatch returns a UUID v4", () => {
    const id = dispatcher.dispatch({ agent: "scout", description: "Find auth flow" });
    expect(id).toMatch(UUID_RE);
  });

  // 2. getStatus returns dispatched task with status='pending'
  test("getStatus returns pending task after dispatch", () => {
    const id = dispatcher.dispatch({ agent: "scout", description: "Find auth flow" });
    const task = dispatcher.getStatus(id);
    expect(task).toBeDefined();
    expect(task!.id).toBe(id);
    expect(task!.status).toBe("pending");
    expect(task!.agent).toBe("scout");
    expect(task!.description).toBe("Find auth flow");
    expect(task!.createdAt).toBeGreaterThan(0);
  });

  // 3. markRunning transitions to 'running' + sets sessionId + startedAt
  test("markRunning transitions to running with sessionId", () => {
    const id = dispatcher.dispatch({ agent: "smith", description: "Refactor utils" });
    dispatcher.markRunning(id, "session-abc");
    const task = dispatcher.getStatus(id);
    expect(task!.status).toBe("running");
    expect(task!.sessionId).toBe("session-abc");
    expect(task!.startedAt).toBeGreaterThan(0);
  });

  // 4. markComplete transitions to 'completed' + sets result + completedAt
  test("markComplete transitions to completed with result", () => {
    const id = dispatcher.dispatch({ agent: "smith", description: "Fix bug" });
    dispatcher.markRunning(id, "session-1");
    dispatcher.markComplete(id, "Fixed in src/utils.ts");
    const task = dispatcher.getStatus(id);
    expect(task!.status).toBe("completed");
    expect(task!.result).toBe("Fixed in src/utils.ts");
    expect(task!.completedAt).toBeGreaterThan(0);
  });

  // 5. markFailed transitions to 'failed' + sets error + completedAt
  test("markFailed transitions to failed with error", () => {
    const id = dispatcher.dispatch({ agent: "scout", description: "Scan deps" });
    dispatcher.markFailed(id, "timeout after 30s");
    const task = dispatcher.getStatus(id);
    expect(task!.status).toBe("failed");
    expect(task!.result).toBe("timeout after 30s");
    expect(task!.completedAt).toBeGreaterThan(0);
  });

  // 6. getActive returns only pending+running (not completed/failed/cancelled)
  test("getActive returns only pending and running tasks", () => {
    const id1 = dispatcher.dispatch({ agent: "a", description: "task1" });
    const id2 = dispatcher.dispatch({ agent: "a", description: "task2" });
    const id3 = dispatcher.dispatch({ agent: "a", description: "task3" });
    const id4 = dispatcher.dispatch({ agent: "a", description: "task4" });

    dispatcher.markRunning(id2, "s1");
    dispatcher.markComplete(id3, "done");
    dispatcher.markFailed(id4, "err");

    const active = dispatcher.getActive();
    const activeIds = active.map((t) => t.id);
    expect(activeIds).toContain(id1);
    expect(activeIds).toContain(id2);
    expect(activeIds).not.toContain(id3);
    expect(activeIds).not.toContain(id4);
    expect(active).toHaveLength(2);
  });

  // 7. reconcile returns completed+failed tasks
  test("reconcile returns completed and failed tasks", () => {
    const id1 = dispatcher.dispatch({ agent: "a", description: "t1" });
    const id2 = dispatcher.dispatch({ agent: "a", description: "t2" });
    const id3 = dispatcher.dispatch({ agent: "a", description: "t3" });

    dispatcher.markComplete(id1, "ok");
    dispatcher.markFailed(id2, "err");
    // id3 stays pending

    const finished = dispatcher.reconcile();
    const finishedIds = finished.map((t) => t.id);
    expect(finishedIds).toContain(id1);
    expect(finishedIds).toContain(id2);
    expect(finishedIds).not.toContain(id3);
    expect(finished).toHaveLength(2);
  });

  // 8. remove deletes the task
  test("remove deletes the task", () => {
    const id = dispatcher.dispatch({ agent: "a", description: "disposable" });
    expect(dispatcher.getStatus(id)).toBeDefined();
    dispatcher.remove(id);
    expect(dispatcher.getStatus(id)).toBeUndefined();
  });

  // 9. stats returns correct counts per status
  test("stats returns correct counts per status", () => {
    dispatcher.dispatch({ agent: "a", description: "p1" });
    const id2 = dispatcher.dispatch({ agent: "a", description: "p2" });
    const id3 = dispatcher.dispatch({ agent: "a", description: "p3" });
    const id4 = dispatcher.dispatch({ agent: "a", description: "p4" });
    const id5 = dispatcher.dispatch({ agent: "a", description: "p5" });

    dispatcher.markRunning(id2, "s");
    dispatcher.markComplete(id3, "ok");
    dispatcher.markFailed(id4, "err");
    dispatcher.cancel(id5);

    const s = dispatcher.stats();
    expect(s.pending).toBe(1);
    expect(s.running).toBe(1);
    expect(s.completed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.cancelled).toBe(1);
  });

  // 10. cancel on pending task → returns true, status='cancelled'
  test("cancel on pending task returns true and sets cancelled", () => {
    const id = dispatcher.dispatch({ agent: "a", description: "cancel me" });
    const result = dispatcher.cancel(id);
    expect(result).toBe(true);
    const task = dispatcher.getStatus(id);
    expect(task!.status).toBe("cancelled");
    expect(task!.completedAt).toBeGreaterThan(0);
  });

  // 11. cancel on completed task → returns false (already terminal)
  test("cancel on completed task returns false", () => {
    const id = dispatcher.dispatch({ agent: "a", description: "done already" });
    dispatcher.markComplete(id, "finished");
    const result = dispatcher.cancel(id);
    expect(result).toBe(false);
    const task = dispatcher.getStatus(id);
    expect(task!.status).toBe("completed"); // unchanged
  });

  // 12. listByAgent returns only tasks for that agent, newest first
  test("listByAgent filters by agent and orders by created_at DESC", () => {
    dispatcher.dispatch({ agent: "scout", description: "first" });
    dispatcher.dispatch({ agent: "smith", description: "other" });
    dispatcher.dispatch({ agent: "scout", description: "third" });

    const scoutTasks = dispatcher.listByAgent("scout");
    expect(scoutTasks).toHaveLength(2);
    // All returned tasks belong to scout
    expect(scoutTasks.every((t) => t.agent === "scout")).toBe(true);
    const descriptions = scoutTasks.map((t) => t.description).sort();
    expect(descriptions).toEqual(["first", "third"]);
    // smith tasks not included
    expect(scoutTasks.some((t) => t.agent === "smith")).toBe(false);
  });

  // 13. dispatch with files+worktree options → persisted and retrievable
  test("dispatch with files and worktree persists them", () => {
    const id = dispatcher.dispatch({
      agent: "painter",
      description: "redesign nav",
      files: ["src/nav.ts", "src/sidebar.ts"],
      worktree: "/tmp/wt/nav-redesign",
    });
    const task = dispatcher.getStatus(id);
    expect(task!.files).toEqual(["src/nav.ts", "src/sidebar.ts"]);
    expect(task!.worktree).toBe("/tmp/wt/nav-redesign");
  });

  // 15. finalize deletes terminal tasks older than threshold
  test("finalize deletes terminal tasks older than threshold", () => {
    const now = Date.now();
    const twoHoursAgo = now - 2 * 60 * 60 * 1000;
    const thirtyMinAgo = now - 30 * 60 * 1000;
    const insertSql = `INSERT INTO background_tasks
      (id, agent, description, status, started_at, completed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.prepare(insertSql).run(
      "old1",
      "a",
      "t1",
      "completed",
      twoHoursAgo,
      twoHoursAgo,
      twoHoursAgo,
    );
    db.prepare(insertSql).run("old2", "a", "t2", "failed", twoHoursAgo, twoHoursAgo, twoHoursAgo);
    db.prepare(insertSql).run(
      "old3",
      "a",
      "t3",
      "cancelled",
      twoHoursAgo,
      twoHoursAgo,
      twoHoursAgo,
    );
    db.prepare(insertSql).run(
      "fresh",
      "a",
      "t4",
      "completed",
      thirtyMinAgo,
      thirtyMinAgo,
      thirtyMinAgo,
    );
    db.prepare(insertSql).run("live", "a", "t5", "running", thirtyMinAgo, null, thirtyMinAgo);

    const deleted = dispatcher.finalize(60 * 60 * 1000); // 1h cutoff
    expect(deleted).toBe(3);

    expect(dispatcher.getStatus("old1")).toBeUndefined();
    expect(dispatcher.getStatus("old2")).toBeUndefined();
    expect(dispatcher.getStatus("old3")).toBeUndefined();
    expect(dispatcher.getStatus("fresh")?.status).toBe("completed");
    expect(dispatcher.getStatus("live")?.status).toBe("running");
  });

  test("finalize is a no-op when no terminal tasks exceed threshold", () => {
    const id = dispatcher.dispatch({ agent: "a", description: "fresh" });
    dispatcher.markComplete(id, "done");

    const deleted = dispatcher.finalize(60 * 60 * 1000);
    expect(deleted).toBe(0);
    expect(dispatcher.getStatus(id)).toBeDefined();
  });

  test("finalize does NOT delete pending or running tasks regardless of age", () => {
    const id = dispatcher.dispatch({ agent: "a", description: "stale pending" });
    // Manually backdate created_at to long ago — finalize must not touch it
    const longAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    db.prepare("UPDATE background_tasks SET created_at = ? WHERE id = ?").run(longAgo, id);

    const deleted = dispatcher.finalize(1000); // 1 second cutoff
    expect(deleted).toBe(0);
    expect(dispatcher.getStatus(id)?.status).toBe("pending");
  });

  // 14. Persistence: new BackgroundDispatcher with SAME db → task still exists
  test("new BackgroundDispatcher with same db sees existing tasks", () => {
    const id = dispatcher.dispatch({ agent: "scout", description: "persist me" });
    // Create a NEW dispatcher with the same db
    const dispatcher2 = new BackgroundDispatcher(db);
    const task = dispatcher2.getStatus(id);
    expect(task).toBeDefined();
    expect(task!.description).toBe("persist me");
    expect(task!.status).toBe("pending");
  });
});
