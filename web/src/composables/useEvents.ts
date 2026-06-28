/**
 * ndomo web — SSE events composable (vueuse useEventSource).
 *
 * Wires the SPA to the backend `/api/events` SSE stream. Auto-reconnect is
 * built in via vueuse (default 2s delay, infinite retries).
 *
 * Browser EventSource can't send custom headers — so `/api/events` MUST be
 * exempt from Basic Auth on the backend (see src/http/auth.ts).
 *
 * Public API:
 *   status — "CONNECTING" | "OPEN" | "CLOSED"
 *   error  — EventSource error event (when CLOSED)
 *   on(type, handler) — subscribe to a typed event; returns unsubscribe fn
 *   onAny(handler)    — subscribe to every event; returns unsubscribe fn
 *   close()           — manually close the stream (no auto-reconnect after)
 *   open()            — reopen after a manual close
 *
 * Server-emitted event types (must match src/events/bus.ts):
 *   plan.created | plan.updated | plan.status_changed | plan.archived
 *   task.created | task.updated | task.status_changed
 *   session.started | session.checkpoint | session.ended
 *   hello (on connect) | error (terminal)
 *
 * Wire format (per SSE spec, encoded by src/http/sse.ts):
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * Implementation note: we use vueuse's `useEventSource` for lifecycle and
 * auto-reconnect, then attach our OWN typed listeners directly to the
 * EventSource. This avoids Vue's reactivity batching: vueuse's listeners
 * update `event.value` and `data.value` refs, and rapid-fire messages would
 * collapse into the last value in a single watch flush. Direct listeners
 * invoke handlers synchronously, so dispatch is reliable even when multiple
 * messages arrive in the same tick.
 */

import { watch, type Ref } from "vue";
import { useEventSource } from "@vueuse/core";

// ─── Public types ────────────────────────────────────────────────────────────

export type SseStatus = "CONNECTING" | "OPEN" | "CLOSED";

export type NdomoEventHandler = (data: unknown) => void;
export type NdomoAnyHandler = (type: string, data: unknown) => void;

export interface UseEventsResult {
  /** Reactive connection state. */
  status: Ref<SseStatus>;
  /** Last error event from EventSource (when CLOSED). */
  error: Ref<Event | null>;
  /** Subscribe to a specific event type. Returns an unsubscribe fn. */
  on(type: string, handler: NdomoEventHandler): () => void;
  /** Subscribe to every event. Returns an unsubscribe fn. */
  onAny(handler: NdomoAnyHandler): () => void;
  /** Manually close the stream (stops auto-reconnect). */
  close(): void;
  /** Manually reopen after close(). */
  open(): void;
}

// ─── Known event types ───────────────────────────────────────────────────────

/**
 * The union of all event names the server may emit. We attach a listener
 * to each so callers can subscribe to typed events via `on(type, handler)`.
 * Adding a new server-side event? Add it here AND in src/events/bus.ts.
 */
const KNOWN_EVENTS: readonly string[] = [
  // Plan events (mirror src/events/bus.ts)
  "plan.created",
  "plan.updated",
  "plan.status_changed",
  "plan.archived",
  // Task events
  "task.created",
  "task.updated",
  "task.status_changed",
  // Session events
  "session.started",
  "session.checkpoint",
  "session.ended",
  // Built-in SSE events
  "hello",
  "error",
];

// ─── Composable ──────────────────────────────────────────────────────────────

export function useEvents(url = "/api/events"): UseEventsResult {
  // vueuse manages the EventSource lifecycle (auto-reconnect, status, error).
  // We pass an empty events[] array because we attach our own listeners below
  // (vueuse's auto-typed listeners update refs in a batched way that loses
  // rapid-fire messages).
  const { status, error, eventSource, close, open } = useEventSource(url, [], {
    autoReconnect: {
      retries: -1, // retry forever
      delay: 2000,
      onFailed: () => {
        // eslint-disable-next-line no-console
        console.warn("[useEvents] auto-reconnect exhausted");
      },
    },
  });

  // Typed handler registry: type → Set<handler>.
  // Wildcard handlers receive every event regardless of type.
  const handlers = new Map<string, Set<NdomoEventHandler>>();
  const wildcardHandlers = new Set<NdomoAnyHandler>();

  // ─── Dispatch a single event ──────────────────────────────────────────────

  function dispatch(type: string, rawData: string | null): void {
    let parsed: unknown = rawData;
    if (typeof rawData === "string") {
      try {
        parsed = JSON.parse(rawData);
      } catch {
        // leave parsed as the raw string — caller decides what to do
      }
    }

    const typed = handlers.get(type);
    if (typed) {
      for (const h of typed) {
        try {
          h(parsed);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[useEvents] handler for "${type}" threw:`, err);
        }
      }
    }

    for (const h of wildcardHandlers) {
      try {
        h(type, parsed);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[useEvents] onAny handler threw:`, err);
      }
    }
  }

  // ─── Attach typed listeners per EventSource instance ──────────────────────
  // Vueuse creates a new EventSource on each (re)connect. We re-attach our
  // listeners each time so we capture messages from the new connection.
  // The watch fires synchronously when eventSource changes.
  watch(
    eventSource,
    (es, _prev, onCleanup) => {
      if (!es) return;
      const attached: Array<[string, EventListener]> = [];
      for (const type of KNOWN_EVENTS) {
        const listener: EventListener = (e: Event) => {
          const msg = e as MessageEvent;
          dispatch(type, msg.data);
        };
        es.addEventListener(type, listener);
        attached.push([type, listener]);
      }
      // Also catch unnamed messages via onmessage for non-typed events.
      // (Server only emits typed events, but defensive coverage costs nothing.)
      const onMsg = (e: Event): void => {
        const msg = e as MessageEvent;
        dispatch("message", msg.data);
      };
      es.addEventListener("message", onMsg);
      attached.push(["message", onMsg]);

      onCleanup(() => {
        for (const [type, listener] of attached) {
          es.removeEventListener(type, listener);
        }
      });
    },
    { immediate: true, flush: "post" },
  );

  // ─── Public API ───────────────────────────────────────────────────────────

  function on(type: string, handler: NdomoEventHandler): () => void {
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  function onAny(handler: NdomoAnyHandler): () => void {
    wildcardHandlers.add(handler);
    return () => {
      wildcardHandlers.delete(handler);
    };
  }

  // Cast vueuse's generic status to our typed union. The three values vueuse
  // emits ("CONNECTING" | "OPEN" | "CLOSED") happen to match SseStatus exactly.
  const typedStatus = status as unknown as Ref<SseStatus>;

  // Cast error ref — vueuse's typing for EventSource error events uses
  // `unknown` in v11, we expose it as `Event | null` for consumer ergonomics.
  const typedError = error as unknown as Ref<Event | null>;

  return {
    status: typedStatus,
    error: typedError,
    on,
    onAny,
    close,
    open,
  };
}

// ─── Event type constants (for ergonomic imports) ────────────────────────────

export const NdomoEventTypes = {
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
} as const;