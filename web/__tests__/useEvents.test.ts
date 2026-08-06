/**
 * Tests for web/src/composables/useEvents.ts — SSE event subscription.
 *
 * Strategy: happy-dom does NOT provide a global EventSource, so we install a
 * minimal MockEventSource on globalThis before importing the composable. The
 * mock tracks instances and lets tests simulate message delivery / open /
 * error transitions.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─── Mock EventSource ────────────────────────────────────────────────────────

type Listener = (event: { data: string; lastEventId?: string; type?: string }) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  withCredentials: boolean;
  readyState: number = 0; // CONNECTING
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;

  // public for tests (allows direct introspection)
  typedListeners = new Map<string, Set<Listener>>();
  closed = false;

  constructor(url: string, opts: { withCredentials?: boolean } = {}) {
    this.url = url;
    this.withCredentials = !!opts.withCredentials;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.typedListeners.get(type);
    if (!set) {
      set = new Set();
      this.typedListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.typedListeners.get(type)?.delete(listener);
  }

  dispatchEvent(evt: Event): boolean {
    return true;
  }

  // ─── Test helpers (NOT part of the real EventSource API) ────────────────

  /** Simulate server → client `event: <name>` + `data: <json>` arrival. */
  simulateMessage(type: string, data: unknown, id?: string): void {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const evt = { data: payload, type, lastEventId: id ?? "" };
    // Per HTML spec: when EventSource receives a named event, it dispatches
    // to listeners registered for that event type ONLY (not onmessage).
    // onmessage fires only for messages without an event name.
    if (type === "" || type === "message") {
      if (this.onmessage) this.onmessage(evt);
      return;
    }
    const typedListeners = this.typedListeners.get(type);
    if (typedListeners) {
      for (const l of typedListeners) l(evt);
    }
  }

  /** Simulate the connection opening. */
  simulateOpen(): void {
    this.readyState = 1;
    if (this.onopen) this.onopen({ data: "", type: "open" });
  }

  /** Simulate a connection error (sets readyState to CLOSED). */
  simulateError(): void {
    this.readyState = 2;
    if (this.onerror) this.onerror({ data: "", type: "error" });
  }

  /** Real EventSource.close() — vueuse calls this on manual close. */
  close(): void {
    this.readyState = 2;
    this.closed = true;
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  // Restore to undefined so the next test installs fresh.
  // @ts-expect-error — intentional cleanup
  delete globalThis.EventSource;
});

// ─── Imports (AFTER mock install) ────────────────────────────────────────────

// useEvents imports vue + vueuse → must be imported AFTER happy-dom is set up
// by vitest. Since vitest config sets environment: "happy-dom", we can import
// directly.
const { useEvents, NdomoEventTypes } = await import("../src/composables/useEvents.ts");

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useEvents — initial state", () => {
  test("uses /api/events as the default SSE URL", () => {
    useEvents();
    const instance = MockEventSource.instances[0];
    expect(instance?.url).toBe("/api/events");
  });

  test("accepts a custom URL", () => {
    useEvents("/api/custom-events");
    expect(MockEventSource.instances[0]?.url).toBe("/api/custom-events");
  });

  test("initial status is CONNECTING", () => {
    const { status } = useEvents();
    expect(status.value).toBe("CONNECTING");
  });
});

describe("useEvents — status transitions", () => {
  test("OPEN when server fires open event", async () => {
    const { status } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");

    instance.simulateOpen();
    expect(status.value).toBe("OPEN");
  });

  test("CLOSED when server fires error", async () => {
    const { status } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");

    instance.simulateOpen();
    instance.simulateError();
    expect(status.value).toBe("CLOSED");
  });
});

describe("useEvents — typed handler dispatch", () => {
  test("plan.created handler receives parsed JSON payload", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    const received: unknown[] = [];
    on("plan.created", (data) => received.push(data));

    instance.simulateMessage("plan.created", { planId: "p1", slug: "demo", title: "Demo" });

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ planId: "p1", slug: "demo", title: "Demo" });
  });

  test("task.updated with JSON payload is parsed and delivered", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    const received: unknown[] = [];
    on("task.updated", (data) => received.push(data));

    instance.simulateMessage("task.updated", { taskId: "t1", status: "done" });

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([{ taskId: "t1", status: "done" }]);
  });

  test("non-JSON payload is delivered as raw string", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    const received: unknown[] = [];
    on("hello", (data) => received.push(data));

    instance.simulateMessage("hello", "not-json");

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual(["not-json"]);
  });

  test("handler registered AFTER a message has already fired does NOT see that message", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    // Fire the message BEFORE any handler exists.
    instance.simulateMessage("plan.created", { planId: "p1" });

    // Register a handler now — it should NOT receive the past message.
    const received: unknown[] = [];
    on("plan.created", (data) => received.push(data));

    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(0);

    // A NEW message fires after registration — should be received.
    instance.simulateMessage("plan.created", { planId: "p2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toEqual([{ planId: "p2" }]);
  });
});

describe("useEvents — wildcard handler dispatch", () => {
  test("onAny receives every event type with type + payload", async () => {
    const { onAny } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    const received: Array<{ type: string; data: unknown }> = [];
    onAny((type, data) => received.push({ type, data }));

    instance.simulateMessage("plan.created", { planId: "p1" });
    instance.simulateMessage("task.updated", { taskId: "t1" });
    instance.simulateMessage("session.ended", { sessionId: "s1" });

    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([
      { type: "plan.created", data: { planId: "p1" } },
      { type: "task.updated", data: { taskId: "t1" } },
      { type: "session.ended", data: { sessionId: "s1" } },
    ]);
  });
});

describe("useEvents — unsubscribe", () => {
  test("returned unsubscribe fn removes the handler", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    const received: unknown[] = [];
    const unsub = on("plan.created", (data) => received.push(data));

    instance.simulateMessage("plan.created", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1);

    unsub();

    instance.simulateMessage("plan.created", { planId: "p2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toHaveLength(1); // no new delivery after unsub
  });

  test("onAny unsub works the same way", async () => {
    const { onAny } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    let count = 0;
    const unsub = onAny(() => count++);

    instance.simulateMessage("plan.created", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(count).toBe(1);

    unsub();
    instance.simulateMessage("plan.created", { planId: "p2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(count).toBe(1);
  });

  test("multiple subscribers for the same type all receive the message", async () => {
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    let a = 0;
    let b = 0;
    on("plan.created", () => a++);
    on("plan.created", () => b++);

    instance.simulateMessage("plan.created", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

describe("useEvents — handler resilience", () => {
  test("throwing handler does not block other handlers", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { on } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");
    instance.simulateOpen();

    let after = 0;
    on("plan.created", () => {
      throw new Error("boom");
    });
    on("plan.created", () => {
      after++;
    });

    instance.simulateMessage("plan.created", { planId: "p1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(after).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe("useEvents — close / open manual control", () => {
  test("close() sets status CLOSED and marks the EventSource closed", () => {
    const { close, status } = useEvents();
    const instance = MockEventSource.instances[0];
    if (!instance) throw new Error("no instance");

    instance.simulateOpen();
    expect(status.value).toBe("OPEN");

    close();
    expect(instance.closed).toBe(true);
  });
});

describe("NdomoEventTypes constants", () => {
  test("exports constants matching the typed event union", () => {
    expect(NdomoEventTypes.PlanCreated).toBe("plan.created");
    expect(NdomoEventTypes.PlanUpdated).toBe("plan.updated");
    expect(NdomoEventTypes.PlanStatusChanged).toBe("plan.status_changed");
    expect(NdomoEventTypes.PlanArchived).toBe("plan.archived");
    expect(NdomoEventTypes.TaskCreated).toBe("task.created");
    expect(NdomoEventTypes.TaskUpdated).toBe("task.updated");
    expect(NdomoEventTypes.TaskStatusChanged).toBe("task.status_changed");
    expect(NdomoEventTypes.SessionStarted).toBe("session.started");
    expect(NdomoEventTypes.SessionCheckpoint).toBe("session.checkpoint");
    expect(NdomoEventTypes.SessionEnded).toBe("session.ended");
    expect(NdomoEventTypes.Hello).toBe("hello");
    expect(NdomoEventTypes.Error).toBe("error");
  });
});