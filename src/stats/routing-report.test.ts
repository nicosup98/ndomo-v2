/**
 * Tests for src/stats/routing-report.ts — routing_events distributions.
 *
 * Fresh in-memory SQLite per test with full migrations (v18 included).
 * Event timestamps are passed explicitly (`createdAt` + injectable `now`)
 * so window/coverage assertions never depend on wall time.
 *
 * Coverage fixtures reuse the direct-SQL insertPlan/insertTask pattern from
 * src/cli/stats.test.ts (tasks are matched read-time via agent + completed_at,
 * so they never need to reference a routing event).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../db/migrations.ts";
import { linkRoutingEvent, recordRoutingEvent } from "../db/routing-events.ts";
import { computeRoutingReport } from "./routing-report.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

/** Create a test plan directly in DB (FK target for tasks). */
function insertPlan(id: string, slug = "routing-report-plan"): void {
  db.query(
    `INSERT INTO plans (id, slug, title, status, priority, created_at, updated_at, session_id, overview, complexity, created_by, updated_by, metadata)
     VALUES (?, ?, 'Test', 'executing', 2, ?, ?, NULL, 'test', 3, 'test', 'test', '{}')`,
  ).run(id, slug, Date.now(), Date.now());
}

/** Insert a task fixture and return its id. */
function insertTask(
  planId: string,
  orderIndex: number,
  fixture: { agent: string; status: string; completedAt?: number | null },
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO plan_tasks (id, plan_id, order_index, description, agent, files, complexity, status,
       verification_status, started_at, completed_at, created_by, updated_by, metadata)
     VALUES (?, ?, ?, 'test task', ?, '[]', 3, ?, 'not_required', ?, ?, 'test', 'test', '{}')`,
  ).run(
    id,
    planId,
    orderIndex,
    fixture.agent,
    fixture.status,
    fixture.completedAt ?? null,
    fixture.completedAt ?? null,
  );
  return id;
}

describe("computeRoutingReport — empty DB", () => {
  test("total 0, null percentages, empty distributions, zeroed coverage", () => {
    const report = computeRoutingReport(db);
    expect(report.since).toBe("all");
    expect(report.windowStart).toBeNull();
    expect(typeof report.generatedAt).toBe("number");
    expect(report.total).toBe(0);
    expect(report.fallbackPct).toBeNull();
    expect(report.explorePct).toBeNull();
    expect(report.bySource).toEqual([]);
    expect(report.byAgent).toEqual([]);
    expect(report.byBucket).toEqual([]);
    expect(report.coverage).toEqual({ linked: 0, inferred: 0, orphan: 0 });
  });
});

describe("computeRoutingReport — distributions", () => {
  test("counts, buckets and deterministic ordering (count desc, key asc)", () => {
    const now = Date.now();
    recordRoutingEvent(db, {
      agent: "js-smith",
      source: "rules",
      intent: "implement",
      stack: "js",
      fallback: true,
      createdAt: now - 4000,
    });
    recordRoutingEvent(db, {
      agent: "js-smith",
      source: "rules",
      intent: "implement",
      stack: "js",
      explore: true,
      createdAt: now - 3000,
    });
    recordRoutingEvent(db, {
      agent: "warden",
      source: "jev",
      intent: "audit",
      stack: "generic",
      createdAt: now - 2000,
    });
    recordRoutingEvent(db, {
      agent: "warden",
      source: "rules",
      intent: "audit",
      stack: "go",
      createdAt: now - 1000,
    });

    const report = computeRoutingReport(db, { now });

    expect(report.total).toBe(4);
    expect(report.bySource).toEqual([
      { source: "rules", count: 3 },
      { source: "jev", count: 1 },
    ]);
    // tie on count → key asc: js-smith < warden
    expect(report.byAgent).toEqual([
      { agent: "js-smith", count: 2 },
      { agent: "warden", count: 2 },
    ]);
    // intent:stack buckets; ties broken by bucket asc
    expect(report.byBucket).toEqual([
      { bucket: "implement:js", count: 2 },
      { bucket: "audit:generic", count: 1 },
      { bucket: "audit:go", count: 1 },
    ]);
    expect(report.fallbackPct).toBe(25); // 1/4
    expect(report.explorePct).toBe(25); // 1/4
  });

  test("percentages round to one decimal (1/3 = 33.3)", () => {
    const now = Date.now();
    recordRoutingEvent(db, { agent: "a", source: "rules", fallback: true, createdAt: now - 2 });
    recordRoutingEvent(db, { agent: "a", source: "rules", createdAt: now - 1 });
    recordRoutingEvent(db, { agent: "a", source: "rules", createdAt: now });

    const report = computeRoutingReport(db, { now });
    expect(report.total).toBe(3);
    expect(report.fallbackPct).toBe(33.3);
    expect(report.explorePct).toBe(0);
  });

  test("null intent/stack fall back to an unknown bucket (never dropped)", () => {
    recordRoutingEvent(db, { agent: "a", source: "rules", createdAt: 1 });
    const report = computeRoutingReport(db, { now: 2 });
    expect(report.total).toBe(1);
    expect(report.byBucket).toEqual([{ bucket: "unknown:generic", count: 1 }]);
  });

  test("byAgent/byBucket are sliced to top 10, bySource stays complete", () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      recordRoutingEvent(db, {
        agent: `agent-${String(i).padStart(2, "0")}`,
        source: `src-${i}`,
        intent: "explore",
        stack: "unknown",
        createdAt: now - 100 + i,
      });
    }
    const report = computeRoutingReport(db, { now });
    expect(report.total).toBe(12);
    expect(report.bySource).toHaveLength(12); // sources are never sliced
    expect(report.byAgent).toHaveLength(10);
    expect(report.byBucket).toHaveLength(1); // all share explore:generic
    // deterministic: count ties → key asc → agent-00 first
    expect(report.byAgent[0]).toEqual({ agent: "agent-00", count: 1 });
    expect(report.byAgent[9]).toEqual({ agent: "agent-09", count: 1 });
  });
});

describe("computeRoutingReport — windows", () => {
  test("10d-old event excluded in 7d, included in 30d/all; 2d-old in 7d", () => {
    const now = Date.now();
    recordRoutingEvent(db, {
      agent: "old-agent",
      source: "rules",
      intent: "explore",
      createdAt: now - 10 * DAY_MS,
    });
    recordRoutingEvent(db, {
      agent: "recent-agent",
      source: "rules",
      intent: "explore",
      createdAt: now - 2 * DAY_MS,
    });

    const week = computeRoutingReport(db, { since: "7d", now });
    expect(week.since).toBe("7d");
    expect(week.windowStart).toBe(now - 7 * DAY_MS);
    expect(week.total).toBe(1);
    expect(week.byAgent).toEqual([{ agent: "recent-agent", count: 1 }]);

    const month = computeRoutingReport(db, { since: "30d", now });
    expect(month.windowStart).toBe(now - 30 * DAY_MS);
    expect(month.total).toBe(2);
    expect(month.byAgent.map((a) => a.agent).sort()).toEqual(["old-agent", "recent-agent"]);

    const all = computeRoutingReport(db, { now });
    expect(all.since).toBe("all");
    expect(all.windowStart).toBeNull();
    expect(all.total).toBe(2);
  });

  test("window lower bound is inclusive (created_at == windowStart counts)", () => {
    const now = Date.now();
    recordRoutingEvent(db, {
      agent: "boundary-agent",
      source: "rules",
      createdAt: now - 7 * DAY_MS,
    });
    const report = computeRoutingReport(db, { since: "7d", now });
    expect(report.total).toBe(1);
  });
});

describe("computeRoutingReport — coverage", () => {
  test("linked / inferred / orphan classification", () => {
    const now = Date.now();
    const planId = crypto.randomUUID();
    insertPlan(planId);

    // linked: event carries task_id
    const linkedTask = insertTask(planId, 0, {
      agent: "a-linked",
      status: "done",
      completedAt: now,
    });
    const linkedEvent = recordRoutingEvent(db, {
      agent: "a-linked",
      source: "rules",
      intent: "implement",
      createdAt: now,
    });
    expect(linkRoutingEvent(db, linkedEvent.id, linkedTask, "done", "not_required")).toBe(true);

    // inferred: same agent, terminal task completed within [now, now+24h]
    insertTask(planId, 1, { agent: "a-infer", status: "done", completedAt: now + HOUR_MS });
    recordRoutingEvent(db, { agent: "a-infer", source: "rules", createdAt: now });

    // orphan: no task at all
    recordRoutingEvent(db, { agent: "a-none", source: "rules", createdAt: now });

    // orphan: terminal task belongs to ANOTHER agent
    insertTask(planId, 2, { agent: "b-other", status: "done", completedAt: now + HOUR_MS });
    recordRoutingEvent(db, { agent: "a-other", source: "rules", createdAt: now });

    // orphan: task never reached a terminal state
    insertTask(planId, 3, { agent: "a-running", status: "running", completedAt: null });
    recordRoutingEvent(db, { agent: "a-running", source: "rules", createdAt: now });

    // orphan: completed outside the 24h inference window
    insertTask(planId, 4, { agent: "a-outside", status: "done", completedAt: now + 25 * HOUR_MS });
    recordRoutingEvent(db, { agent: "a-outside", source: "rules", createdAt: now });

    // orphan: task completed BEFORE the event (stale, not attributable)
    insertTask(planId, 5, { agent: "a-stale", status: "failed", completedAt: now - 1000 });
    recordRoutingEvent(db, { agent: "a-stale", source: "rules", createdAt: now });

    const report = computeRoutingReport(db, { now });
    expect(report.total).toBe(7);
    expect(report.coverage).toEqual({ linked: 1, inferred: 1, orphan: 5 });
  });

  test("inference boundary: completed_at exactly event+24h counts, +1ms does not", () => {
    const now = Date.now();
    const planId = crypto.randomUUID();
    insertPlan(planId);

    insertTask(planId, 0, { agent: "a-boundary", status: "done", completedAt: now + 24 * HOUR_MS });
    recordRoutingEvent(db, { agent: "a-boundary", source: "rules", createdAt: now });

    insertTask(planId, 1, {
      agent: "a-just-out",
      status: "failed",
      completedAt: now + 24 * HOUR_MS + 1,
    });
    recordRoutingEvent(db, { agent: "a-just-out", source: "rules", createdAt: now });

    const report = computeRoutingReport(db, { now });
    expect(report.total).toBe(2);
    expect(report.coverage).toEqual({ linked: 0, inferred: 1, orphan: 1 });
  });

  test("a linked event is never double-counted as inferred", () => {
    const now = Date.now();
    const planId = crypto.randomUUID();
    insertPlan(planId);
    const taskId = insertTask(planId, 0, {
      agent: "a-both",
      status: "done",
      completedAt: now + 1000,
    });
    const event = recordRoutingEvent(db, { agent: "a-both", source: "rules", createdAt: now });
    linkRoutingEvent(db, event.id, taskId, "done", "not_required");

    const report = computeRoutingReport(db, { now });
    expect(report.coverage).toEqual({ linked: 1, inferred: 0, orphan: 0 });
  });
});
