/**
 * Tests for the circuit-breaker core module (src/db/circuit-breaker.ts) and
 * its safe integration point with `updateTaskStatus` (the DB side effect the
 * plugin performs on a trip).
 *
 * The core module is pure (no DB import); these tests exercise it in
 * isolation plus one focused integration that confirms failing a real task
 * with the canonical error string works through the existing tasks API.
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  CIRCUIT_BREAKER_ERROR,
  CircuitBreaker,
  type CircuitBreakerCheckResult,
  canonicalizeArgs,
  DEFAULT_IDENTICAL_THRESHOLD,
  DEFAULT_TOTAL_THRESHOLD,
  resolveCircuitBreakerTaskFailure,
} from "./circuit-breaker.ts";
import { runMigrations } from "./migrations.ts";
import { planCreateExecutor } from "./plan-create.ts";
import { createTasksBatch, updateTaskStatus } from "./tasks.ts";

// ─── canonicalizeArgs ────────────────────────────────────────────────────────

describe("canonicalizeArgs", () => {
  test("deterministic regardless of object key insertion order", () => {
    expect(canonicalizeArgs({ b: 2, a: 1 })).toBe(canonicalizeArgs({ a: 1, b: 2 }));
  });

  test("distinguishes different values", () => {
    expect(canonicalizeArgs({ a: 1 })).not.toBe(canonicalizeArgs({ a: 2 }));
  });

  test("handles undefined explicitly (not dropped like JSON.stringify)", () => {
    const a = canonicalizeArgs({ a: undefined });
    const b = canonicalizeArgs({});
    expect(a).not.toBe(b);
    expect(a).toContain("[Undefined]");
  });

  test("serializes circular references without infinite recursion", () => {
    const obj: Record<string, unknown> = { x: 1 };
    obj.self = obj;
    const out = canonicalizeArgs(obj);
    expect(out).toContain("[Circular]");
    // Same structure → same canonical string (deterministic).
    const obj2: Record<string, unknown> = { x: 1 };
    obj2.self = obj2;
    expect(canonicalizeArgs(obj2)).toBe(out);
  });

  test("handles bigint, function, symbol, NaN, Infinity", () => {
    expect(canonicalizeArgs(10n)).toBe(`"[BigInt:10]"`);
    expect(canonicalizeArgs(() => {})).toBe(`"[Function]"`);
    expect(canonicalizeArgs(Symbol("s"))).toContain("[Symbol:Symbol(s)]");
    expect(canonicalizeArgs(Number.NaN)).toContain("[Number:NaN]");
    expect(canonicalizeArgs(Number.POSITIVE_INFINITY)).toContain("[Number:Infinity]");
  });

  test("handles null / undefined / primitives at the root", () => {
    expect(canonicalizeArgs(null)).toBe("null");
    expect(canonicalizeArgs(undefined)).toBe(`"[Undefined]"`);
    expect(canonicalizeArgs("hi")).toBe(`"hi"`);
    expect(canonicalizeArgs(42)).toBe("42");
  });

  test("arrays serialize positionally", () => {
    expect(canonicalizeArgs([1, 2, 3])).toBe(canonicalizeArgs([1, 2, 3]));
    expect(canonicalizeArgs([1, 2, 3])).not.toBe(canonicalizeArgs([3, 2, 1]));
  });

  test("never throws on a getter that throws", () => {
    const evil: Record<string, unknown> = {};
    Object.defineProperty(evil, "boom", {
      get() {
        throw new Error("nope");
      },
      enumerable: true,
    });
    // Must not throw — falls back to String(args).
    expect(() => canonicalizeArgs(evil)).not.toThrow();
  });
});

// ─── resolveCircuitBreakerTaskFailure ────────────────────────────────────────

describe("resolveCircuitBreakerTaskFailure", () => {
  test("returns id for a task tool using `id`", () => {
    expect(resolveCircuitBreakerTaskFailure("task_list", { id: "t-123" })).toBe("t-123");
  });

  test("returns taskId for a task tool using `taskId`", () => {
    expect(resolveCircuitBreakerTaskFailure("task_add_artifact", { taskId: "t-9" })).toBe("t-9");
  });

  test("prefers taskId when both present", () => {
    expect(
      resolveCircuitBreakerTaskFailure("task_review", { taskId: "from-taskId", id: "from-id" }),
    ).toBe("from-taskId");
  });

  test("returns null for non-task tools (never fails arbitrary resource ids)", () => {
    expect(resolveCircuitBreakerTaskFailure("plan_get", { id: "plan-1" })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("analysis_get", { id: "an-1" })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("session_end", { id: "ses-1" })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("write", { filePath: "/x" })).toBeNull();
  });

  test("returns null for task_update_status (recursion / semantic guard)", () => {
    // Marking the status-update target failed would recurse into the very
    // status machinery the caller was exercising and clobber their intent.
    expect(resolveCircuitBreakerTaskFailure("task_update_status", { id: "t-1" })).toBeNull();
  });

  test("returns null for empty / non-string ids", () => {
    expect(resolveCircuitBreakerTaskFailure("task_list", { id: "" })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("task_list", { id: "   " })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("task_list", { id: 123 })).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("task_list", {})).toBeNull();
  });

  test("returns null when args is null / not an object", () => {
    expect(resolveCircuitBreakerTaskFailure("task_list", null)).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("task_list", "str")).toBeNull();
    expect(resolveCircuitBreakerTaskFailure("task_list", undefined)).toBeNull();
  });
});

// ─── CircuitBreaker — configuration ──────────────────────────────────────────

describe("CircuitBreaker — defaults & configuration", () => {
  test("uses default thresholds when no config given", () => {
    const cb = new CircuitBreaker();
    expect(cb.config.totalThreshold).toBe(DEFAULT_TOTAL_THRESHOLD);
    expect(cb.config.identicalThreshold).toBe(DEFAULT_IDENTICAL_THRESHOLD);
    expect(cb.config.totalThreshold).toBe(4000);
    expect(cb.config.identicalThreshold).toBe(20);
  });

  test("honors configurable total threshold", () => {
    const cb = new CircuitBreaker({ totalThreshold: 5 });
    expect(cb.config.totalThreshold).toBe(5);
    // identical keeps its default
    expect(cb.config.identicalThreshold).toBe(DEFAULT_IDENTICAL_THRESHOLD);
  });

  test("honors configurable identical threshold", () => {
    const cb = new CircuitBreaker({ identicalThreshold: 3 });
    expect(cb.config.identicalThreshold).toBe(3);
    expect(cb.config.totalThreshold).toBe(DEFAULT_TOTAL_THRESHOLD);
  });

  test("coerces malformed threshold values back to defaults (never disables protection)", () => {
    expect(new CircuitBreaker({ totalThreshold: 0 }).config.totalThreshold).toBe(
      DEFAULT_TOTAL_THRESHOLD,
    );
    expect(new CircuitBreaker({ totalThreshold: -5 }).config.totalThreshold).toBe(
      DEFAULT_TOTAL_THRESHOLD,
    );
    expect(new CircuitBreaker({ totalThreshold: Number.NaN }).config.totalThreshold).toBe(
      DEFAULT_TOTAL_THRESHOLD,
    );
    expect(
      new CircuitBreaker({ totalThreshold: Number.POSITIVE_INFINITY }).config.totalThreshold,
    ).toBe(DEFAULT_TOTAL_THRESHOLD);
    // 3.7 floors to 3 — still a valid finite positive integer.
    expect(new CircuitBreaker({ totalThreshold: 3.7 }).config.totalThreshold).toBe(3);
  });

  test("sub-1 fractional thresholds fall back to default (regression: floor(0.1)===0 disabled safety)", () => {
    // BUG (pre-fix): toSafeThreshold checked `value <= 0` BEFORE Math.floor,
    // so 0.1 (which is > 0) passed the guard, then floor(0.1) === 0 was
    // returned. Threshold 0 → in check(), `callCount >= 0` is always true →
    // the breaker tripped on the very FIRST call, inverting its safety
    // guarantee. Any sub-1 positive fraction MUST fall back to the default
    // rather than floor down to a disabling 0.
    expect(new CircuitBreaker({ totalThreshold: 0.1 }).config.totalThreshold).toBe(
      DEFAULT_TOTAL_THRESHOLD,
    );
    // Second sub-1 positive (upper edge of the bug range).
    expect(new CircuitBreaker({ totalThreshold: 0.9 }).config.totalThreshold).toBe(
      DEFAULT_TOTAL_THRESHOLD,
    );
    // Mirror the guard on the identical threshold.
    expect(new CircuitBreaker({ identicalThreshold: 0.5 }).config.identicalThreshold).toBe(
      DEFAULT_IDENTICAL_THRESHOLD,
    );
    // Boundary sanity: exactly 1 still floors to 1 (NOT the default).
    expect(new CircuitBreaker({ totalThreshold: 1 }).config.totalThreshold).toBe(1);
    expect(new CircuitBreaker({ identicalThreshold: 1 }).config.identicalThreshold).toBe(1);
  });
});

// ─── CircuitBreaker — total threshold ────────────────────────────────────────

describe("CircuitBreaker — total threshold trip", () => {
  test("trips exactly on the Nth call (N = total threshold)", () => {
    const cb = new CircuitBreaker({ totalThreshold: 5, identicalThreshold: 999 });
    // calls 1..4 healthy
    for (let i = 1; i <= 4; i++) {
      const r = cb.check("s1", "plan_get", { id: `p-${i}` });
      expect(r.blocked).toBe(false);
      expect(r.trippedNow).toBe(false);
      expect(r.callCount).toBe(i);
    }
    // 5th call crosses total → trips
    const trip = cb.check("s1", "plan_get", { id: "p-5" });
    expect(trip.blocked).toBe(true);
    expect(trip.trippedNow).toBe(true);
    expect(trip.reason).toBe("total");
    expect(trip.callCount).toBe(5);
  });

  test("varied calls still trip on total volume", () => {
    const cb = new CircuitBreaker({ totalThreshold: 3, identicalThreshold: 999 });
    cb.check("s", "a", { x: 1 });
    cb.check("s", "b", { x: 2 });
    const trip = cb.check("s", "c", { x: 3 });
    expect(trip.trippedNow).toBe(true);
    expect(trip.reason).toBe("total");
  });
});

// ─── CircuitBreaker — identical threshold ────────────────────────────────────

describe("CircuitBreaker — identical consecutive threshold trip", () => {
  test("trips on the Nth consecutive identical call", () => {
    const cb = new CircuitBreaker({ totalThreshold: 999, identicalThreshold: 3 });
    const args = { query: "same", limit: 5 };
    cb.check("s", "task_search", args); // identical=1
    cb.check("s", "task_search", args); // identical=2
    const trip = cb.check("s", "task_search", args); // identical=3 → trip
    expect(trip.blocked).toBe(true);
    expect(trip.trippedNow).toBe(true);
    expect(trip.reason).toBe("identical");
    expect(trip.identicalCount).toBe(3);
  });

  test("identical counter resets when tool changes", () => {
    const cb = new CircuitBreaker({ totalThreshold: 999, identicalThreshold: 3 });
    cb.check("s", "a", { q: 1 });
    cb.check("s", "a", { q: 1 }); // identical=2
    // different tool → identical resets to 1
    const r = cb.check("s", "b", { q: 1 });
    expect(r.identicalCount).toBe(1);
    expect(r.blocked).toBe(false);
  });

  test("identical counter resets when args change (same tool)", () => {
    const cb = new CircuitBreaker({ totalThreshold: 999, identicalThreshold: 3 });
    cb.check("s", "task_search", { q: "x" });
    cb.check("s", "task_search", { q: "x" }); // identical=2
    // different args → resets
    const r = cb.check("s", "task_search", { q: "y" });
    expect(r.identicalCount).toBe(1);
    expect(r.blocked).toBe(false);
  });

  test("identical detection is order-independent via canonical args", () => {
    const cb = new CircuitBreaker({ totalThreshold: 999, identicalThreshold: 3 });
    cb.check("s", "task_search", { a: 1, b: 2 });
    cb.check("s", "task_search", { b: 2, a: 1 }); // canonically equal → identical=2
    const trip = cb.check("s", "task_search", { b: 2, a: 1 }); // identical=3 → trip
    expect(trip.trippedNow).toBe(true);
    expect(trip.reason).toBe("identical");
  });
});

// ─── CircuitBreaker — one-shot trip + reset ──────────────────────────────────

describe("CircuitBreaker — one-shot trip and reset", () => {
  test("after trip, subsequent calls block silently (no re-warn / no reason)", () => {
    const cb = new CircuitBreaker({ totalThreshold: 2, identicalThreshold: 999 });
    cb.check("s", "a", {});
    const trip = cb.check("s", "a", {}); // 2nd → trip
    expect(trip.trippedNow).toBe(true);

    // subsequent calls: blocked but trippedNow=false, reason=null
    const r2 = cb.check("s", "a", {});
    expect(r2.blocked).toBe(true);
    expect(r2.trippedNow).toBe(false);
    expect(r2.reason).toBeNull();
    const r3 = cb.check("s", "other", { z: 9 });
    expect(r3.blocked).toBe(true);
    expect(r3.trippedNow).toBe(false);
    expect(r3.reason).toBeNull();
  });

  test("reset() clears the session so it can run again", () => {
    const cb = new CircuitBreaker({ totalThreshold: 2, identicalThreshold: 999 });
    cb.check("s", "a", {}); // call 1 healthy
    const trip = cb.check("s", "a", {}); // call 2 → trip
    expect(trip.trippedNow).toBe(true);
    expect(cb.check("s", "a", {}).blocked).toBe(true);

    cb.reset("s");
    // fresh session — allowed again, counters restart
    const fresh = cb.check("s", "a", {});
    expect(fresh.blocked).toBe(false);
    expect(fresh.callCount).toBe(1);
    expect(fresh.trippedNow).toBe(false);
  });
});

// ─── CircuitBreaker — per-session isolation ──────────────────────────────────

describe("CircuitBreaker — per-session isolation", () => {
  test("a trip in one session does not affect another", () => {
    const cb = new CircuitBreaker({ totalThreshold: 999, identicalThreshold: 2 });
    // session A: two identical calls → trip on the 2nd
    cb.check("A", "task_search", { q: "x" });
    expect(cb.check("A", "task_search", { q: "x" }).trippedNow).toBe(true);
    // session B is independent: its own identical streak starts fresh and
    // stays healthy across several calls.
    const b1 = cb.check("B", "task_search", { q: "x" });
    expect(b1.blocked).toBe(false);
    expect(b1.callCount).toBe(1);
    expect(cb.check("A", "task_search", { q: "x" }).blocked).toBe(true); // A stays blocked
    const b2 = cb.check("B", "task_search", { q: "x" }); // B identical=2 → B trips too
    expect(b2.trippedNow).toBe(true);
    // But a brand-new session C is completely unaffected by A and B.
    const c1 = cb.check("C", "plan_get", { id: "p" });
    expect(c1.blocked).toBe(false);
    expect(c1.callCount).toBe(1);
  });

  test("empty/undefined sessionId collapses to a shared namespace", () => {
    const cb = new CircuitBreaker({ totalThreshold: 2, identicalThreshold: 999 });
    cb.check("", "a", {});
    cb.check(undefined as unknown as string, "a", {});
    // both empty-string calls share one session state → trip on 2nd
    const snap = cb.snapshot("");
    expect(snap?.callCount).toBe(2);
    expect(snap?.tripped).toBe(true);
  });
});

// ─── CircuitBreaker — check() result shape ───────────────────────────────────

describe("CircuitBreaker — check() result shape", () => {
  test("healthy call returns full result with blocked=false", () => {
    const cb = new CircuitBreaker();
    const r: CircuitBreakerCheckResult = cb.check("s", "plan_get", { id: "x" });
    expect(r).toEqual({
      blocked: false,
      reason: null,
      callCount: 1,
      identicalCount: 1,
      trippedNow: false,
    });
  });
});

// ─── Integration: updateTaskStatus with the breaker error ────────────────────

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
});

describe("integration — task-fail side effect (existing updateTaskStatus API)", () => {
  function seedTask(): string {
    const plan = planCreateExecutor(
      db,
      { slug: "cb-plan", title: "CB Plan", overview: "for breaker test", priority: 3 },
      { agent: "test" },
    );
    const [task] = createTasksBatch(db, plan.id, [
      { description: "do thing", agent: "smith", createdBy: "test" },
    ]);
    if (!task) throw new Error("seed task not created");
    return task.id;
  }

  test("failing a task with the circuit-breaker error string works through updateTaskStatus", () => {
    const taskId = seedTask();
    const result = updateTaskStatus(
      db,
      taskId,
      "failed",
      { error: CIRCUIT_BREAKER_ERROR },
      "ndomo-circuit-breaker",
      { agent: "ndomo-circuit-breaker", sessionId: "ses-1" },
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe("failed");
    expect(result?.error).toBe(CIRCUIT_BREAKER_ERROR);
    expect(result?.completedAt).not.toBeNull();
  });

  test("resolveCircuitBreakerTaskFailure gates which trips actually fail a task (recursion guard)", () => {
    // Simulate the plugin's decision logic for several tripping tools:
    const cases: Array<{ tool: string; args: unknown; expectTarget: boolean }> = [
      { tool: "task_update_status", args: { id: "t-1" }, expectTarget: false }, // never fails
      { tool: "task_add_artifact", args: { taskId: "t-2" }, expectTarget: true },
      { tool: "plan_get", args: { id: "p-1" }, expectTarget: false }, // non-task tool
    ];
    for (const c of cases) {
      const target = resolveCircuitBreakerTaskFailure(c.tool, c.args);
      expect(target !== null).toBe(c.expectTarget);
    }
  });

  test("failing a non-existent task id returns null (no throw)", () => {
    // The breaker may extract an id that does not match any row. The existing
    // API must degrade safely rather than throw and mask the breaker error.
    const result = updateTaskStatus(
      db,
      "does-not-exist-uuid",
      "failed",
      { error: CIRCUIT_BREAKER_ERROR },
      "ndomo-circuit-breaker",
      { agent: "ndomo-circuit-breaker", sessionId: "ses-1" },
    );
    expect(result).toBeNull();
  });
});
