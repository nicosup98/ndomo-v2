/**
 * ndomo web — SSE-driven auto-refresh composable.
 *
 * Singleton useEvents instance (one SSE connection shared across all views).
 * Provides debounced refresh wiring: when SSE events arrive, schedule a
 * microtask flush that calls refresh() once per unique URL even if N events
 * fire in rapid succession (e.g. task_create_batch).
 *
 * Usage:
 *   const { status } = useSseRefresh({
 *     events: ["plan.created", "plan.updated"],
 *     refreshKey: `/api/plans/${id}`,
 *     refresh: plans.refresh,
 *     filter: (p) => p.planId === id,   // optional
 *   });
 */

import { onUnmounted, type Ref } from "vue";
import {
  useEvents,
  type SseStatus,
  type UseEventsResult,
} from "./useEvents";

// ─── Singleton useEvents ─────────────────────────────────────────────────────

let shared: UseEventsResult | null = null;

function getSharedEvents(): UseEventsResult {
  if (!shared) {
    shared = useEvents();
  }
  return shared;
}

// ─── Debounced refresh scheduler ─────────────────────────────────────────────

type RefreshFn = () => void;

const pending = new Map<string, RefreshFn>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // Flush on next microtask — coalesces rapid-fire events into one batch.
  queueMicrotask(flush);
}

function flush(): void {
  flushScheduled = false;
  for (const fn of pending.values()) {
    fn();
  }
  pending.clear();
}

function enqueue(key: string, fn: RefreshFn): void {
  pending.set(key, fn);
  scheduleFlush();
}

/**
 * Reset internal scheduler state. Exported for tests only.
 */
export function _resetSseRefreshScheduler(): void {
  pending.clear();
  flushScheduled = false;
}

// ─── Composable ──────────────────────────────────────────────────────────────

export interface UseSseRefreshOptions {
  /** Event types to subscribe to (e.g. "plan.created", "task.*"). */
  events: string[];
  /** Unique key for dedup (usually the API URL). */
  refreshKey: string;
  /** The refresh function from useApi. */
  refresh: RefreshFn;
  /**
   * Optional payload filter. Return true to accept the event.
   * Use for detail views to match on planId/taskId.
   */
  filter?: (payload: unknown) => boolean;
}

export interface UseSseRefreshResult {
  /** Reactive SSE connection status. */
  status: Ref<SseStatus>;
}

export function useSseRefresh(
  options: UseSseRefreshOptions,
): UseSseRefreshResult {
  const { events, refreshKey, refresh, filter } = options;
  const { status, on } = getSharedEvents();

  const unsubs: Array<() => void> = [];

  // Register immediately in setup (not onMounted) so tests work outside
  // component context. SSE subscription during setup is fine — the connection
  // is already alive via the shared singleton.
  for (const type of events) {
    const unsub = on(type, (payload) => {
      if (filter && !filter(payload)) return;
      enqueue(refreshKey, refresh);
    });
    unsubs.push(unsub);
  }

  onUnmounted(() => {
    for (const unsub of unsubs) unsub();
  });

  return { status };
}
