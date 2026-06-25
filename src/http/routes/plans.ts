// ─── Plans Routes ─────────────────────────────────────────────────────────────
/**
 * GET /api/plans           — list plans (optional filters: status, sessionId, limit)
 * GET /api/plans/search    — FTS5 search (required: q, optional: limit)
 * GET /api/plans/:id       — get single plan by id
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { getPlan, listPlans, searchPlans } from "../../db/plans.ts";
import type { PlanStatus } from "../../db/types.ts";

const PlanStatusValues = [
  "draft",
  "approved",
  "executing",
  "completed",
  "failed",
  "abandoned",
] as const;

export function plansRoute(db: Database) {
  return new Elysia({ name: "plans" })
    .get(
      "/api/plans",
      async ({ query }) => {
        const opts: { status?: PlanStatus; sessionId?: string; limit?: number } = {};
        if (query.status) opts.status = query.status as PlanStatus;
        if (query.sessionId) opts.sessionId = query.sessionId;
        if (query.limit) opts.limit = query.limit;
        return listPlans(db, opts);
      },
      {
        query: t.Object({
          status: t.Optional(t.UnionEnum(PlanStatusValues)),
          sessionId: t.Optional(t.String()),
          limit: t.Optional(t.Number({ minimum: 1, maximum: 500 })),
        }),
      },
    )
    .get(
      "/api/plans/search",
      async ({ query }) => {
        return searchPlans(db, query.q, query.limit ?? 20);
      },
      {
        query: t.Object({
          q: t.String({ minLength: 1 }),
          limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
        }),
      },
    )
    .get(
      "/api/plans/:id",
      async ({ params: { id }, set }) => {
        const plan = getPlan(db, id);
        if (!plan) {
          set.status = 404;
          return { error: "not_found", message: `plan ${id} not found` };
        }
        return plan;
      },
      {
        params: t.Object({ id: t.String() }),
      },
    );
}
