/**
 * ndomo DB — Session lifecycle management.
 *
 * Sessions track continuity across multiple agents working
 * toward a shared goal. They record checkpoints, agent history,
 * and key decisions.
 *
 * Post-commit hooks: each lifecycle mutation emits a typed event on the
 * in-process bus (`src/events/bus.ts`) so SSE subscribers can react
 * without polling. Bus emits happen AFTER the DB write so subscribers
 * never observe unpublished state.
 */

import type { Database } from "bun:sqlite";
import { bus } from "../events/bus.ts";
import type { Session, SessionMetadata } from "./types.ts";
import { sessionFromRow } from "./types.ts";

/**
 * Idempotent upsert: ensure a session row exists for FK integrity.
 *
 * Used by plan_create and plan transition functions so that the harness
 * session ID (ctx.sessionID) always has a matching row in `sessions`.
 * INSERT OR IGNORE is safe — if the row already exists, this is a no-op.
 * Does NOT call `startSession` (which requires full Session shape).
 */
export function ensureSession(
  db: Database,
  sessionId: string,
  fallbackGoal: string,
  createdBy = "auto",
): void {
  const now = Date.now();
  db.query(
    `INSERT OR IGNORE INTO sessions (id, started_at, last_checkpoint, goal, state, agent_history, created_by)
     VALUES (?, ?, ?, ?, '{}', '[]', ?)`,
  ).run(sessionId, now, now, fallbackGoal, createdBy);
}

export function startSession(
  db: Database,
  session: {
    id: string;
    goal: string;
    planId?: string;
    metadata?: SessionMetadata;
    createdBy?: string;
    sourceMessageId?: string;
  },
): Session {
  const now = Date.now();
  const meta = session.metadata ?? {};
  db.query(
    `INSERT INTO sessions (id, started_at, last_checkpoint, plan_id, goal, state, agent_history, key_decisions, metadata, created_by, source_message_id)
     VALUES (?, ?, ?, ?, ?, '{}', '[]', NULL, ?, ?, ?)`,
  ).run(
    session.id,
    now,
    now,
    session.planId ?? null,
    session.goal,
    JSON.stringify(meta),
    session.createdBy ?? "unknown",
    session.sourceMessageId ?? null,
  );
  const created = getSession(db, session.id);
  if (!created) throw new Error("ndomo: failed to create session");

  // Live-reactivity hook: notify subscribers that a new session started.
  bus.emit({
    type: "session.started",
    sessionId: created.id,
    planId: created.planId,
    goal: created.goal,
    timestamp: Date.now(),
  });

  return created;
}

export function getSession(db: Database, id: string): Session | null {
  const row = db.query("SELECT * FROM sessions WHERE id = ?").get(id);
  return row ? sessionFromRow(row) : null;
}

export function listSessions(
  db: Database,
  opts: { planId?: string; limit?: number; includeArchived?: boolean } = {},
): Session[] {
  const limit = opts.limit ?? 20;
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.planId) {
    conditions.push("plan_id = ?");
    params.push(opts.planId);
  }
  if (!opts.includeArchived) {
    conditions.push("archived_at IS NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = db
    .query(`SELECT * FROM sessions ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...params);
  return (rows as unknown[]).map((r) => sessionFromRow(r));
}

export function checkpointSession(
  db: Database,
  id: string,
  state: Record<string, unknown>,
  keyDecisions?: string,
): Session | null {
  const now = Date.now();
  const result = db
    .query(
      "UPDATE sessions SET last_checkpoint = ?, state = ?, key_decisions = COALESCE(?, key_decisions) WHERE id = ?",
    )
    .run(now, JSON.stringify(state), keyDecisions ?? null, id);
  if (result.changes === 0) return null;

  // Live-reactivity hook: notify subscribers of the checkpoint.
  const sess = getSession(db, id);
  if (sess) {
    bus.emit({
      type: "session.checkpoint",
      sessionId: sess.id,
      keyDecisions: sess.keyDecisions,
      timestamp: Date.now(),
    });
  }
  return sess;
}

export function appendAgentHistory(
  db: Database,
  id: string,
  entry: {
    agent: string;
    taskId?: string;
    startedAt?: number;
    endedAt?: number | null;
  },
): Session | null {
  const sess = getSession(db, id);
  if (!sess) return null;
  const history = [...sess.agentHistory, { ...entry, startedAt: entry.startedAt ?? Date.now() }];
  db.query("UPDATE sessions SET agent_history = ? WHERE id = ?").run(JSON.stringify(history), id);
  return getSession(db, id);
}

export function endSession(db: Database, id: string): Session | null {
  const now = Date.now();
  const result = db
    .query("UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
    .run(now, id);
  if (result.changes === 0) return null;

  // Live-reactivity hook: notify subscribers that the session ended.
  const sess = getSession(db, id);
  if (sess) {
    bus.emit({
      type: "session.ended",
      sessionId: sess.id,
      outcome: sess.outcome,
      timestamp: Date.now(),
    });
  }
  return sess;
}
