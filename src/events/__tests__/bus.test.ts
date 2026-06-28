/**
 * Tests for src/events/bus.ts — typed in-process pub/sub.
 *
 * Covers:
 *  - emit / on / off round-trip for each event type
 *  - type narrowing (handler receives the strongly-typed payload)
 *  - onAny() wildcard receives all events
 *  - handler exceptions don't break the publisher
 *  - createBus() returns an isolated instance
 *  - listenerCount + removeAllListeners
 */

import { describe, expect, test } from "bun:test";
import {
  type EventBus,
  bus,
  createBus,
  type PlanCreatedEvent,
  type PlanStatusChangedEvent,
  type SessionStartedEvent,
  type TaskStatusChangedEvent,
} from "../bus.ts";

function makePlanCreated(overrides: Partial<PlanCreatedEvent> = {}): PlanCreatedEvent {
  return {
    type: "plan.created",
    planId: "plan_1",
    slug: "demo",
    title: "Demo plan",
    status: "draft",
    priority: 2,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("bus — emit/on basics", () => {
  test("subscribed handler receives emitted plan.created", () => {
    const local = createBus();
    const received: PlanCreatedEvent[] = [];
    local.on("plan.created", (e) => received.push(e));

    const ev = makePlanCreated({ planId: "p1" });
    local.emit(ev);

    expect(received).toHaveLength(1);
    expect(received[0]?.planId).toBe("p1");
    expect(received[0]?.type).toBe("plan.created");
  });

  test("multiple handlers on same event all fire", () => {
    const local = createBus();
    let countA = 0;
    let countB = 0;
    local.on("plan.created", () => countA++);
    local.on("plan.created", () => countB++);

    local.emit(makePlanCreated());
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  test("off() removes the handler", () => {
    const local = createBus();
    let calls = 0;
    const handler = (): void => {
      calls++;
    };
    local.on("plan.created", handler);
    local.emit(makePlanCreated());
    expect(calls).toBe(1);

    local.off("plan.created", handler);
    local.emit(makePlanCreated());
    expect(calls).toBe(1);
  });

  test("off() with unknown handler is a no-op (no throw)", () => {
    const local = createBus();
    const handler = (): void => {};
    expect(() => local.off("plan.created", handler)).not.toThrow();
  });
});

describe("bus — type narrowing", () => {
  test("plan.status_changed handler receives status_change payload", () => {
    const local = createBus();
    let prev = "";
    let next = "";
    local.on("plan.status_changed", (e) => {
      prev = e.previousStatus;
      next = e.status;
    });

    const ev: PlanStatusChangedEvent = {
      type: "plan.status_changed",
      planId: "p2",
      slug: "x",
      title: "X",
      previousStatus: "draft",
      status: "approved",
      timestamp: Date.now(),
    };
    local.emit(ev);
    expect(prev).toBe("draft");
    expect(next).toBe("approved");
  });

  test("task.status_changed handler receives task payload", () => {
    const local = createBus();
    let captured: TaskStatusChangedEvent | undefined;
    local.on("task.status_changed", (e) => {
      captured = e;
    });

    const ev: TaskStatusChangedEvent = {
      type: "task.status_changed",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      previousStatus: "pending",
      status: "running",
      timestamp: Date.now(),
    };
    local.emit(ev);
    expect(captured?.taskId).toBe("t1");
    expect(captured?.previousStatus).toBe("pending");
  });

  test("session.started handler receives session payload", () => {
    const local = createBus();
    let captured: SessionStartedEvent | undefined;
    local.on("session.started", (e) => {
      captured = e;
    });

    const ev: SessionStartedEvent = {
      type: "session.started",
      sessionId: "s1",
      planId: "p1",
      goal: "ship it",
      timestamp: Date.now(),
    };
    local.emit(ev);
    expect(captured?.sessionId).toBe("s1");
    expect(captured?.goal).toBe("ship it");
  });
});

describe("bus — onAny / offAny wildcard", () => {
  test("onAny() receives every event type", () => {
    const local = createBus();
    const seen: string[] = [];
    local.onAny((e) => seen.push(e.type));

    local.emit(makePlanCreated());
    local.emit({
      type: "session.started",
      sessionId: "s1",
      planId: null,
      goal: "g",
      timestamp: Date.now(),
    });
    local.emit({
      type: "task.updated",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      status: "done",
      timestamp: Date.now(),
    });

    expect(seen).toEqual(["plan.created", "session.started", "task.updated"]);
  });

  test("offAny() stops delivery to wildcard handler", () => {
    const local = createBus();
    let calls = 0;
    const handler = (): void => {
      calls++;
    };
    local.onAny(handler);
    local.emit(makePlanCreated());
    expect(calls).toBe(1);

    local.offAny(handler);
    local.emit(makePlanCreated());
    expect(calls).toBe(1);
  });
});

describe("bus — resilience", () => {
  test("handler exception does not stop other handlers", () => {
    const local = createBus();
    let after = 0;
    local.on("plan.created", () => {
      throw new Error("boom");
    });
    local.on("plan.created", () => {
      after++;
    });

    expect(() => local.emit(makePlanCreated())).not.toThrow();
    expect(after).toBe(1);
  });

  test("onAny() handler exception does not break subsequent delivery", () => {
    const local = createBus();
    let after = 0;
    local.onAny(() => {
      throw new Error("boom-any");
    });
    local.onAny(() => {
      after++;
    });

    local.emit(makePlanCreated());
    expect(after).toBe(1);
  });
});

describe("bus — diagnostics & lifecycle", () => {
  test("listenerCount() reports typed subscribers", () => {
    const local = createBus();
    expect(local.listenerCount("plan.created")).toBe(0);

    const noop = (): void => {};
    local.on("plan.created", noop);
    local.on("plan.created", noop);
    expect(local.listenerCount("plan.created")).toBe(2);
  });

  test("removeAllListeners() clears typed + wildcard", () => {
    const local = createBus();
    local.on("plan.created", () => {});
    local.onAny(() => {});

    expect(local.listenerCount("plan.created")).toBe(1);
    local.removeAllListeners();
    expect(local.listenerCount("plan.created")).toBe(0);

    let seen = 0;
    local.onAny(() => seen++);
    local.emit(makePlanCreated());
    expect(seen).toBe(1);
  });
});

describe("bus — singleton isolation", () => {
  test("createBus() returns a fresh instance, not the singleton", () => {
    const fresh = createBus();
    expect(fresh).not.toBe(bus);
  });

  test("singleton and createBus() deliver independently", () => {
    const singletonCalls: string[] = [];
    const localCalls: string[] = [];
    const local = createBus();

    bus.on("plan.created", (e) => singletonCalls.push(e.planId));
    local.on("plan.created", (e) => localCalls.push(e.planId));

    local.emit(makePlanCreated({ planId: "from-local" }));

    expect(localCalls).toEqual(["from-local"]);
    expect(singletonCalls).toEqual([]);

    // cleanup singleton side-effect for other tests
    bus.removeAllListeners();
  });
});

describe("bus — fan-out across event types", () => {
  test("each plan.* / task.* / session.* delivers to its own channel", () => {
    const local: EventBus = createBus();
    const calls: string[] = [];
    local.on("plan.created", () => calls.push("plan.created"));
    local.on("plan.updated", () => calls.push("plan.updated"));
    local.on("plan.status_changed", () => calls.push("plan.status_changed"));
    local.on("plan.archived", () => calls.push("plan.archived"));
    local.on("task.created", () => calls.push("task.created"));
    local.on("task.updated", () => calls.push("task.updated"));
    local.on("task.status_changed", () => calls.push("task.status_changed"));
    local.on("session.started", () => calls.push("session.started"));
    local.on("session.checkpoint", () => calls.push("session.checkpoint"));
    local.on("session.ended", () => calls.push("session.ended"));

    local.emit(makePlanCreated());
    local.emit({
      type: "plan.updated",
      planId: "p1",
      slug: "x",
      title: "X",
      status: "executing",
      timestamp: Date.now(),
    });
    local.emit({
      type: "plan.status_changed",
      planId: "p1",
      slug: "x",
      title: "X",
      previousStatus: "draft",
      status: "approved",
      timestamp: Date.now(),
    });
    local.emit({
      type: "plan.archived",
      planId: "p1",
      slug: "x",
      title: "X",
      timestamp: Date.now(),
    });
    local.emit({
      type: "task.created",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      description: "do thing",
      timestamp: Date.now(),
    });
    local.emit({
      type: "task.updated",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      status: "running",
      timestamp: Date.now(),
    });
    local.emit({
      type: "task.status_changed",
      taskId: "t1",
      planId: "p1",
      agent: "craftsman",
      previousStatus: "pending",
      status: "done",
      timestamp: Date.now(),
    });
    local.emit({
      type: "session.started",
      sessionId: "s1",
      planId: "p1",
      goal: "g",
      timestamp: Date.now(),
    });
    local.emit({
      type: "session.checkpoint",
      sessionId: "s1",
      keyDecisions: "decided",
      timestamp: Date.now(),
    });
    local.emit({
      type: "session.ended",
      sessionId: "s1",
      outcome: "success",
      timestamp: Date.now(),
    });

    expect(calls).toEqual([
      "plan.created",
      "plan.updated",
      "plan.status_changed",
      "plan.archived",
      "task.created",
      "task.updated",
      "task.status_changed",
      "session.started",
      "session.checkpoint",
      "session.ended",
    ]);
  });
});