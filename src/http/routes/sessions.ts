// ─── Sessions Routes ──────────────────────────────────────────────────────────
/**
 * GET /api/sessions          — list sessions (optional: planId, limit)
 * GET /api/sessions/active   — list active sessions (endedAt === null)
 * GET /api/sessions/:id      — get single session by id
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { getSession, listSessions } from "../../db/sessions.ts";

export function sessionsRoute(db: Database) {
  return new Elysia({ name: "sessions" })
    .get(
      "/api/sessions",
      async ({ query }) => {
        const opts: { planId?: string; limit?: number } = {};
        if (query.planId) opts.planId = query.planId;
        if (query.limit) opts.limit = query.limit;
        return listSessions(db, opts);
      },
      {
        query: t.Object({
          planId: t.Optional(t.String()),
          limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
        }),
      },
    )
    .get(
      "/api/sessions/active",
      async () => {
        // Fetch all recent sessions and filter active (endedAt === null)
        const all = listSessions(db, { limit: 20 });
        return all.filter((s) => s.endedAt === null);
      },
    )
    .get(
      "/api/sessions/:id",
      async ({ params: { id }, set }) => {
        const session = getSession(db, id);
        if (!session) {
          set.status = 404;
          return { error: "not_found", message: `session ${id} not found` };
        }
        return session;
      },
      {
        params: t.Object({ id: t.String() }),
      },
    );
}
