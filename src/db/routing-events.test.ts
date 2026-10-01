import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "./migrations.ts";
import {
  getRoutingEvent,
  type InsertRoutingEvent,
  linkRoutingEvent,
  pruneRoutingEvents,
  ROUTING_EVENTS_MAX,
  type RoutingEvent,
  recordRoutingEvent,
} from "./routing-events.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function countRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) as c FROM routing_events").get() as { c: number };
  return row.c;
}

/** Read that must exist — throws instead of leaning on a non-null assertion. */
function mustGet(db: Database, id: string): RoutingEvent {
  const row = getRoutingEvent(db, id);
  if (!row) throw new Error(`routing event '${id}' not found`);
  return row;
}

describe("routing events — record/get/prune/link", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
  });

  describe("recordRoutingEvent", () => {
    test("inserts a full row — every provided field round-trips", () => {
      const evt: InsertRoutingEvent = {
        sessionId: "ses_abc",
        agent: "craftsman",
        source: "foreman",
        intent: "bugfix",
        stack: "bun,typescript,biome",
        risk: "low",
        confidence: 0.87,
        fallback: true,
        explore: false,
      };
      const saved = recordRoutingEvent(db, evt);

      expect(saved.id).toMatch(UUID_RE);
      expect(saved.agent).toBe(evt.agent);
      expect(saved.source).toBe(evt.source);
      expect(saved.sessionId).toBe(evt.sessionId ?? null);
      expect(saved.intent).toBe(evt.intent ?? null);
      expect(saved.stack).toBe(evt.stack ?? null);
      expect(saved.risk).toBe(evt.risk ?? null);
      expect(saved.confidence).toBe(evt.confidence ?? null);
      expect(saved.fallback).toBe(1);
      expect(saved.explore).toBe(0);
      // not-yet-linked columns stay null
      expect(saved.taskId).toBeNull();
      expect(saved.taskStatus).toBeNull();
      expect(saved.verificationStatus).toBeNull();
      expect(saved.linkedAt).toBeNull();
      expect(saved.linkSource).toBeNull();

      // persisted row (not just the return value)
      const raw = db
        .query("SELECT agent, source, confidence, fallback FROM routing_events WHERE id = ?")
        .get(saved.id) as { agent: string; source: string; confidence: number; fallback: number };
      expect(raw.agent).toBe("craftsman");
      expect(raw.source).toBe("foreman");
      expect(raw.confidence).toBeCloseTo(0.87);
      expect(raw.fallback).toBe(1);
      expect(countRows(db)).toBe(1);
    });

    test("defaults: fallback=0, explore=0, nulls where omitted, createdAt ≈ now", () => {
      const before = Date.now();
      const saved = recordRoutingEvent(db, { agent: "smith", source: "auto" });
      const after = Date.now();

      expect(saved.sessionId).toBeNull();
      expect(saved.intent).toBeNull();
      expect(saved.stack).toBeNull();
      expect(saved.risk).toBeNull();
      expect(saved.confidence).toBeNull();
      expect(saved.fallback).toBe(0);
      expect(saved.explore).toBe(0);
      expect(saved.createdAt).toBeGreaterThanOrEqual(before);
      expect(saved.createdAt).toBeLessThanOrEqual(after);
      expect(saved.createdAt).toBeGreaterThan(before - 1000);
    });

    test("explicit createdAt is respected", () => {
      const explicit = 1_700_000_000_000;
      const saved = recordRoutingEvent(db, {
        agent: "smith",
        source: "manual",
        createdAt: explicit,
      });
      expect(saved.createdAt).toBe(explicit);
      const raw = db.query("SELECT created_at FROM routing_events WHERE id = ?").get(saved.id) as {
        created_at: number;
      };
      expect(raw.created_at).toBe(explicit);
    });

    test("explore=true maps to 1", () => {
      const saved = recordRoutingEvent(db, { agent: "smith", source: "manual", explore: true });
      expect(saved.explore).toBe(1);
      expect(saved.fallback).toBe(0);
    });
  });

  describe("pruneRoutingEvents (FIFO cap)", () => {
    test(`keeps ${ROUTING_EVENTS_MAX} newest rows after inserting cap+3`, () => {
      const start = performance.now();
      const ids: string[] = [];
      let newestId = "";
      const base = Date.now() - (ROUTING_EVENTS_MAX + 10) * 1000;
      for (let i = 0; i < ROUTING_EVENTS_MAX + 3; i++) {
        const saved = recordRoutingEvent(db, {
          agent: "smith",
          source: "manual",
          createdAt: base + i,
        });
        ids.push(saved.id);
        newestId = saved.id;
      }
      const elapsedMs = Math.round(performance.now() - start);

      // cap respected on the last insert
      expect(countRows(db)).toBe(ROUTING_EVENTS_MAX);

      // the 3 oldest events are gone, the newest survives
      for (const id of ids.slice(0, 3)) {
        expect(getRoutingEvent(db, id)).toBeNull();
      }
      expect(getRoutingEvent(db, newestId)).not.toBeNull();

      // report the budget (perf regression signal)
      if (elapsedMs > 10_000) {
        console.warn(`routing events prune test took ${elapsedMs}ms (budget 10000ms)`);
      }
      expect(elapsedMs).toBeLessThan(10_000);
    }, 30_000);

    test("pruneRoutingEvents is a no-op below the cap", () => {
      recordRoutingEvent(db, { agent: "smith", source: "manual" });
      recordRoutingEvent(db, { agent: "smith", source: "manual" });
      expect(pruneRoutingEvents(db)).toBe(0);
      expect(countRows(db)).toBe(2);
    });
  });

  describe("linkRoutingEvent (guarded, write-once)", () => {
    test("links a fresh event, then rejects the second link", () => {
      const saved = recordRoutingEvent(db, { agent: "craftsman", source: "foreman" });

      const ok = linkRoutingEvent(db, saved.id, "task-1", "done", "passed");
      expect(ok).toBe(true);

      const linked = mustGet(db, saved.id);
      expect(linked.taskId).toBe("task-1");
      expect(linked.taskStatus).toBe("done");
      expect(linked.verificationStatus).toBe("passed");
      expect(linked.linkedAt).toBeNumber();
      expect(linked.linkSource).toBe("explicit");

      // second link → false, row untouched
      const again = linkRoutingEvent(db, saved.id, "task-2", "failed", "failed");
      expect(again).toBe(false);
      const after = mustGet(db, saved.id);
      expect(after.taskId).toBe("task-1");
      expect(after.taskStatus).toBe("done");
      expect(after.verificationStatus).toBe("passed");
      expect(after.linkedAt).toBe(linked.linkedAt);
      expect(after.linkSource).toBe("explicit");
    });

    test("link accepts a null verificationStatus", () => {
      const saved = recordRoutingEvent(db, { agent: "smith", source: "manual" });
      expect(linkRoutingEvent(db, saved.id, "task-3", "failed", null)).toBe(true);
      const linked = mustGet(db, saved.id);
      expect(linked.taskId).toBe("task-3");
      expect(linked.verificationStatus).toBeNull();
      expect(linked.linkSource).toBe("explicit");
    });

    test("link on unknown id returns false (no throw)", () => {
      expect(linkRoutingEvent(db, "does-not-exist", "task-1", "done", "passed")).toBe(false);
    });
  });

  describe("getRoutingEvent", () => {
    test("returns null for an unknown id", () => {
      expect(getRoutingEvent(db, "nope")).toBeNull();
    });

    test("round-trips a recorded event", () => {
      const saved = recordRoutingEvent(db, {
        agent: "smith",
        source: "manual",
        intent: "feature",
      });
      const fetched = getRoutingEvent(db, saved.id);
      expect(fetched).toEqual(saved);
    });
  });
});
