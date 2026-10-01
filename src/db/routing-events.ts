/**
 * ndomo DB — Routing events (route decision log, harness-intelligence fase 2).
 *
 * One slim row per `route` tool invocation: agent, source, intent/stack/risk,
 * confidence, fallback/explore flags, and — once the foreman links it —
 * the task the decision spawned plus its terminal verification status.
 *
 * Design notes (see .ndomo/designs/2026-10-01-routing-events-design.md):
 *  - FIFO retention cap (ROUTING_EVENTS_MAX) is enforced in the APP layer on
 *    every insert (prune-en-insert), no SQLite triggers.
 *  - `linkRoutingEvent` is guarded + write-once: an event links to a task at
 *    most once, so a second call returns false and leaves the row untouched.
 *  - Missing reads return `null` (repo convention: never throw on not-found).
 *  - No FK to plan_tasks on purpose: routing events must survive task
 *    re-creation/archival and stay queryable after the task is gone.
 *
 * All functions take a Database instance and return camelCase TS types.
 */

import type { Database } from "bun:sqlite";

/** FIFO retention cap — rows kept per project. Pure constant (no config). */
export const ROUTING_EVENTS_MAX = 5000;

/** Input shape for {@link recordRoutingEvent} — everything optional but agent/source. */
export interface InsertRoutingEvent {
  sessionId?: string | null;
  agent: string;
  source: string;
  intent?: string | null;
  stack?: string | null;
  risk?: string | null;
  confidence?: number | null;
  fallback?: boolean;
  explore?: boolean;
  /** Epoch ms. Defaults to `Date.now()` when omitted. */
  createdAt?: number;
}

/** camelCase projection of a `routing_events` row. */
export interface RoutingEvent {
  id: string;
  createdAt: number;
  sessionId: string | null;
  agent: string;
  source: string;
  intent: string | null;
  stack: string | null;
  risk: string | null;
  confidence: number | null;
  /** SQLite boolean: 0 | 1 (kept as integer for raw-row parity). */
  fallback: number;
  /** SQLite boolean: 0 | 1 (kept as integer for raw-row parity). */
  explore: number;
  taskId: string | null;
  taskStatus: string | null;
  verificationStatus: string | null;
  linkedAt: number | null;
  linkSource: string | null;
}

/** Raw snake_case row shape (see SCHEMA_V18_SQL in schema.ts). */
interface RoutingEventRow {
  id: string;
  created_at: number;
  session_id: string | null;
  agent: string;
  source: string;
  intent: string | null;
  stack: string | null;
  risk: string | null;
  confidence: number | null;
  fallback: number;
  explore: number;
  task_id: string | null;
  task_status: string | null;
  verification_status: string | null;
  linked_at: number | null;
  link_source: string | null;
}

/** Pure snake→camel mapper. */
function rowToRoutingEvent(row: unknown): RoutingEvent {
  const r = row as RoutingEventRow;
  return {
    id: r.id,
    createdAt: r.created_at,
    sessionId: r.session_id,
    agent: r.agent,
    source: r.source,
    intent: r.intent,
    stack: r.stack,
    risk: r.risk,
    confidence: r.confidence,
    fallback: r.fallback,
    explore: r.explore,
    taskId: r.task_id,
    taskStatus: r.task_status,
    verificationStatus: r.verification_status,
    linkedAt: r.linked_at,
    linkSource: r.link_source,
  };
}

/**
 * Read a single routing event by id.
 * Returns `null` for unknown ids (repo "not found → null" convention).
 */
export function getRoutingEvent(db: Database, id: string): RoutingEvent | null {
  const row = db.query("SELECT * FROM routing_events WHERE id = ?").get(id);
  return row ? rowToRoutingEvent(row) : null;
}

/**
 * Enforce the FIFO retention cap: keep only the ROUTING_EVENTS_MAX newest
 * rows, ordered by `created_at DESC` with `rowid DESC` as deterministic
 * tiebreak (insertion order wins when timestamps are equal).
 *
 * @returns Number of rows deleted (0 when already at/below the cap).
 */
export function pruneRoutingEvents(db: Database): number {
  const row = db.query<{ total: number }, []>("SELECT COUNT(*) AS total FROM routing_events").get();
  const total = row?.total ?? 0;
  if (total <= ROUTING_EVENTS_MAX) return 0;
  const res = db
    .query(
      `DELETE FROM routing_events WHERE rowid NOT IN (
         SELECT rowid FROM routing_events ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    )
    .run(ROUTING_EVENTS_MAX);
  return res.changes;
}

/**
 * Record a routing decision (INSERT + FIFO prune) and return the stored row.
 *
 * The row is re-read after insert so callers observe the persisted form.
 * Fallback: if an explicit `createdAt` predates the retention floor of an
 * already-full table, prune() evicts the row just inserted — the local
 * projection is returned so the declared contract (non-null) still holds.
 * Default `Date.now()` always lands at the top of the window, so this path
 * is unreachable in production traffic.
 */
export function recordRoutingEvent(db: Database, evt: InsertRoutingEvent): RoutingEvent {
  const event: RoutingEvent = {
    id: crypto.randomUUID(),
    createdAt: evt.createdAt ?? Date.now(),
    sessionId: evt.sessionId ?? null,
    agent: evt.agent,
    source: evt.source,
    intent: evt.intent ?? null,
    stack: evt.stack ?? null,
    risk: evt.risk ?? null,
    confidence: evt.confidence ?? null,
    fallback: evt.fallback ? 1 : 0,
    explore: evt.explore ? 1 : 0,
    taskId: null,
    taskStatus: null,
    verificationStatus: null,
    linkedAt: null,
    linkSource: null,
  };

  db.query(
    `INSERT INTO routing_events (id, created_at, session_id, agent, source, intent, stack, risk, confidence, fallback, explore)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.createdAt,
    event.sessionId,
    event.agent,
    event.source,
    event.intent,
    event.stack,
    event.risk,
    event.confidence,
    event.fallback,
    event.explore,
  );

  pruneRoutingEvents(db);
  return getRoutingEvent(db, event.id) ?? event;
}

/**
 * Link an event to the task it spawned (write-once, guarded).
 *
 * @returns `false` when the event does not exist or is already linked;
 *   `true` when this call performed the UPDATE. The WHERE clause re-checks
 *   `task_id IS NULL`, so racing writers can't double-link either.
 */
export function linkRoutingEvent(
  db: Database,
  eventId: string,
  taskId: string,
  taskStatus: string,
  verificationStatus: string | null,
): boolean {
  const existing = db
    .query<{ task_id: string | null }, [string]>("SELECT task_id FROM routing_events WHERE id = ?")
    .get(eventId);
  if (!existing || existing.task_id !== null) return false;
  const res = db
    .query(
      `UPDATE routing_events
       SET task_id = ?, task_status = ?, verification_status = ?, linked_at = ?, link_source = 'explicit'
       WHERE id = ? AND task_id IS NULL`,
    )
    .run(taskId, taskStatus, verificationStatus, Date.now(), eventId);
  return res.changes > 0;
}
