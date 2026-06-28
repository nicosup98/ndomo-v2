/**
 * ndomo — In-process typed pub/sub event bus.
 *
 * Backend counterpart of `web/src/composables/useEvents.ts`. The bus bridges
 * database writers (plan/task/session hooks in src/db/*.ts) to the SSE route
 * (src/http/routes/events.ts) so the SPA receives live updates.
 *
 * Design:
 * - Thin wrapper around Node's `EventEmitter` for zero-dep reliability.
 * - Strongly-typed `EventMap` so emit/on are type-checked end-to-end.
 * - Singleton export `bus` plus factory `createBus()` for tests (isolated
 *   instances prevent cross-test bleed through the singleton).
 * - Async-safe: handlers are called synchronously by emit() but the route
 *   subscribes via `.on()` so messages queue while no consumer is reading.
 *
 * Naming: events use dotted notation `domain.action`:
 *   plan.created | plan.updated | plan.status_changed | plan.archived
 *   task.created | task.updated | task.status_changed
 *   session.started | session.checkpoint | session.ended
 *
 * Subscribers can listen to a wildcard via `bus.onAny(handler)` for diagnostics.
 */

import { EventEmitter } from "node:events";

// ─── Event payloads ──────────────────────────────────────────────────────────

export interface PlanEventBase {
  planId: string;
  slug: string;
  title: string;
  /** Unix epoch ms */
  timestamp: number;
}

export interface PlanCreatedEvent extends PlanEventBase {
  type: "plan.created";
  status: string;
  priority: number;
}

export interface PlanUpdatedEvent extends PlanEventBase {
  type: "plan.updated";
  status: string;
}

export interface PlanStatusChangedEvent extends PlanEventBase {
  type: "plan.status_changed";
  previousStatus: string;
  status: string;
}

export interface PlanArchivedEvent extends PlanEventBase {
  type: "plan.archived";
}

export type PlanEvent =
  | PlanCreatedEvent
  | PlanUpdatedEvent
  | PlanStatusChangedEvent
  | PlanArchivedEvent;

// ─── Task events ─────────────────────────────────────────────────────────────

export interface TaskEventBase {
  taskId: string;
  planId: string;
  agent: string;
  /** Unix epoch ms */
  timestamp: number;
}

export interface TaskCreatedEvent extends TaskEventBase {
  type: "task.created";
  description: string;
}

export interface TaskUpdatedEvent extends TaskEventBase {
  type: "task.updated";
  status: string;
}

export interface TaskStatusChangedEvent extends TaskEventBase {
  type: "task.status_changed";
  previousStatus: string;
  status: string;
}

export type TaskEvent = TaskCreatedEvent | TaskUpdatedEvent | TaskStatusChangedEvent;

// ─── Session events ──────────────────────────────────────────────────────────

export interface SessionEventBase {
  sessionId: string;
  /** Unix epoch ms */
  timestamp: number;
}

export interface SessionStartedEvent extends SessionEventBase {
  type: "session.started";
  goal: string;
  planId: string | null;
}

export interface SessionCheckpointEvent extends SessionEventBase {
  type: "session.checkpoint";
  keyDecisions: string | null;
}

export interface SessionEndedEvent extends SessionEventBase {
  type: "session.ended";
  outcome: string | null;
}

export type SessionEvent = SessionStartedEvent | SessionCheckpointEvent | SessionEndedEvent;

// ─── Union type ──────────────────────────────────────────────────────────────

export type NdomoEvent = PlanEvent | TaskEvent | SessionEvent;
export type NdomoEventType = NdomoEvent["type"];

// ─── Type-safe handler alias ─────────────────────────────────────────────────

export type EventHandler<E extends NdomoEvent = NdomoEvent> = (event: E) => void;

/**
 * Maps event type string → typed event payload. TypeScript picks the right
 * payload when calling `bus.on("plan.created", (e) => ...)` — `e` is
 * automatically narrowed to `PlanCreatedEvent`.
 */
export interface EventMap {
  "plan.created": PlanCreatedEvent;
  "plan.updated": PlanUpdatedEvent;
  "plan.status_changed": PlanStatusChangedEvent;
  "plan.archived": PlanArchivedEvent;
  "task.created": TaskCreatedEvent;
  "task.updated": TaskUpdatedEvent;
  "task.status_changed": TaskStatusChangedEvent;
  "session.started": SessionStartedEvent;
  "session.checkpoint": SessionCheckpointEvent;
  "session.ended": SessionEndedEvent;
}

// ─── Bus interface ───────────────────────────────────────────────────────────

export interface EventBus {
  /** Type-safe emit — TS narrows payload from the literal event.type field. */
  emit<E extends NdomoEvent>(event: E): void;
  /** Type-safe subscribe — handler receives the strongly-typed payload. */
  on<E extends NdomoEventType>(type: E, handler: EventHandler<Extract<NdomoEvent, { type: E }>>): void;
  /** Unsubscribe a previously-registered handler. */
  off<E extends NdomoEventType>(type: E, handler: EventHandler<Extract<NdomoEvent, { type: E }>>): void;
  /** Subscribe to ALL event types (diagnostics / metrics). */
  onAny(handler: EventHandler): void;
  /** Unsubscribe from wildcard. */
  offAny(handler: EventHandler): void;
  /** Drop every listener — used in tests. */
  removeAllListeners(): void;
  /** Current listener count (diagnostics). */
  listenerCount(type?: NdomoEventType): number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class TypedEventBus implements EventBus {
  private readonly emitter = new EventEmitter();
  private readonly anyHandlers = new Set<EventHandler>();

  constructor() {
    // Bump default cap (10) since the SSE route + diagnostics can attach many
    // handlers without exhausting the limit on a single event type.
    this.emitter.setMaxListeners(100);
  }

  emit<E extends NdomoEvent>(event: E): void {
    // Emit on both the typed channel AND the wildcard so onAny() works.
    // Wrap each listener call in try/catch so one buggy subscriber can't
    // take down the publisher (Node EventEmitter throws synchronously by
    // default — we override that here for publisher resilience).
    const typedListeners = this.emitter.listeners(event.type);
    for (const listener of typedListeners) {
      try {
        (listener as (...args: unknown[]) => void)(event);
      } catch {
        // never let a buggy listener kill the publisher
      }
    }
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch {
        // never let a buggy listener kill the publisher
      }
    }
  }

  on<E extends NdomoEventType>(
    type: E,
    handler: EventHandler<Extract<NdomoEvent, { type: E }>>,
  ): void {
    this.emitter.on(type, handler as (...args: unknown[]) => void);
  }

  off<E extends NdomoEventType>(
    type: E,
    handler: EventHandler<Extract<NdomoEvent, { type: E }>>,
  ): void {
    this.emitter.off(type, handler as (...args: unknown[]) => void);
  }

  onAny(handler: EventHandler): void {
    this.anyHandlers.add(handler);
  }

  offAny(handler: EventHandler): void {
    this.anyHandlers.delete(handler);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
    this.anyHandlers.clear();
  }

  listenerCount(type?: NdomoEventType): number {
    if (type === undefined) {
      // Sum listeners on each typed channel + wildcard handlers.
      // We never emit on the ALL_EVENTS channel directly, so summing
      // per-type is the canonical count of registered handlers.
      let total = this.anyHandlers.size;
      for (const evt of [
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
      ]) {
        total += this.emitter.listenerCount(evt);
      }
      return total;
    }
    return this.emitter.listenerCount(type);
  }
}

// ─── Singleton + factory ─────────────────────────────────────────────────────

/**
 * Default singleton — used by the SSE route and DB writer hooks.
 *
 * Tests should call `createBus()` for an isolated instance to avoid
 * cross-test bleed through module-level state.
 */
export const bus: EventBus = new TypedEventBus();

/** Build a fresh bus instance (used in tests). */
export function createBus(): EventBus {
  return new TypedEventBus();
}