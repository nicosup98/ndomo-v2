/**
 * Tests for web/src/composables/useSseRefresh.ts — SSE-driven auto-refresh.
 *
 * Strategy: mock useEvents at module level, test debounced refresh scheduling,
 * filtering, and lifecycle wiring.
 */

import { describe, expect, test, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

// ─── Mock useEvents ──────────────────────────────────────────────────────────

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function mockOn(type: string, handler: Handler): () => void {
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
  }
  set.add(handler);
  return () => set?.delete(handler);
}

const mockStatus = ref<"CONNECTING" | "OPEN" | "CLOSED">("CONNECTING");

vi.mock("../src/composables/useEvents.ts", () => ({
  useEvents: () => ({
    status: mockStatus,
    error: ref(null),
    on: mockOn,
    onAny: vi.fn(),
    close: vi.fn(),
    open: vi.fn(),
  }),
  NdomoEventTypes: {
    PlanCreated: "plan.created",
    PlanUpdated: "plan.updated",
    PlanStatusChanged: "plan.status_changed",
    PlanArchived: "plan.archived",
    TaskCreated: "task.created",
    TaskUpdated: "task.updated",
    TaskStatusChanged: "task.status_changed",
    SessionStarted: "session.started",
    SessionCheckpoint: "session.checkpoint",
    SessionEnded: "session.ended",
    Hello: "hello",
    Error: "error",
  },
}));

// ─── Imports (after mock) ────────────────────────────────────────────────────

const { useSseRefresh, _resetSseRefreshScheduler } = await import("../src/composables/useSseRefresh.ts");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emit(type: string, data: unknown): void {
  const set = handlers.get(type);
  if (set) {
    for (const h of set) h(data);
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  handlers.clear();
  _resetSseRefreshScheduler();
  mockStatus.value = "CONNECTING";
});

describe("useSseRefresh — basic wiring", () => {
  test("subscribes to specified event types on mount", async () => {
    const refresh = vi.fn();
    useSseRefresh({
      events: ["plan.created", "task.updated"],
      refreshKey: "/api/test",
      refresh,
    });

    await nextTick();

    emit("plan.created", { planId: "p1" });
    await nextTick();
    // flush microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(refresh).toHaveBeenCalled();
  });

  test("does not call refresh for unsubscribed event types", async () => {
    const refresh = vi.fn();
    useSseRefresh({
      events: ["plan.created"],
      refreshKey: "/api/test",
      refresh,
    });

    await nextTick();

    emit("task.updated", { taskId: "t1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("useSseRefresh — debounced refresh", () => {
  test("coalesces rapid-fire events into one refresh per key", async () => {
    const refresh = vi.fn();
    useSseRefresh({
      events: ["task.created"],
      refreshKey: "/api/tasks",
      refresh,
    });

    await nextTick();

    // Simulate task_create_batch emitting 5 events in same tick
    emit("task.created", { taskId: "t1" });
    emit("task.created", { taskId: "t2" });
    emit("task.created", { taskId: "t3" });
    emit("task.created", { taskId: "t4" });
    emit("task.created", { taskId: "t5" });

    await new Promise((r) => setTimeout(r, 0));

    // Should only refresh once despite 5 events
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("different refreshKey flushes independently", async () => {
    const refreshA = vi.fn();
    const refreshB = vi.fn();

    useSseRefresh({
      events: ["plan.created"],
      refreshKey: "/api/plans",
      refresh: refreshA,
    });
    useSseRefresh({
      events: ["plan.created"],
      refreshKey: "/api/tasks",
      refresh: refreshB,
    });

    await nextTick();

    emit("plan.created", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshA).toHaveBeenCalledTimes(1);
    expect(refreshB).toHaveBeenCalledTimes(1);
  });
});

describe("useSseRefresh — payload filter", () => {
  test("calls refresh only when filter returns true", async () => {
    const refresh = vi.fn();
    useSseRefresh({
      events: ["plan.updated"],
      refreshKey: `/api/plans/p1`,
      refresh,
      filter: (p) => (p as Record<string, unknown>)?.planId === "p1",
    });

    await nextTick();

    // Matching payload
    emit("plan.updated", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(1);

    // Non-matching payload
    emit("plan.updated", { planId: "p2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(refresh).toHaveBeenCalledTimes(1); // still 1
  });
});

describe("useSseRefresh — status passthrough", () => {
  test("exposes reactive status from shared useEvents", () => {
    const { status } = useSseRefresh({
      events: ["hello"],
      refreshKey: "/test",
      refresh: vi.fn(),
    });

    expect(status.value).toBe("CONNECTING");

    mockStatus.value = "OPEN";
    expect(status.value).toBe("OPEN");

    mockStatus.value = "CLOSED";
    expect(status.value).toBe("CLOSED");
  });
});
