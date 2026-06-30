// ─── Plans Routes ─────────────────────────────────────────────────────────────
/**
 * GET  /api/plans                — list plans (optional filters: status, sessionId, limit)
 * GET  /api/plans/search         — FTS5 search (required: q, optional: limit)
 * GET  /api/plans/:id            — get single plan by id
 * POST /api/plans                — create a new plan
 * PUT  /api/plans/:id            — update plan fields (partial)
 * PATCH /api/plans/:id/status    — transition plan status
 * POST /api/plans/:id/approve    — approve a plan (draft → approved)
 * DELETE /api/plans/:id          — delete a plan (with guards)
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
  approvePlan,
  createPlan,
  deletePlan,
  getPlan,
  listPlans,
  searchPlans,
  updatePlanFields,
  updatePlanStatus,
} from "../../db/plans.ts";
import { createTask } from "../../db/tasks.ts";
import type { PlanStatus } from "../../db/types.ts";
import {
  PlanApproveBody,
  PlanCreateBody,
  PlanDeleteBody,
  PlanStatusPatchBody,
  PlanStatusValues,
  PlanUpdateBody,
  TaskCreateBody,
} from "../schemas.ts";

export function plansRoute(db: Database) {
  return new Elysia({ name: "plans" })
    // ─── GET routes (existing) ───────────────────────────────────────────────
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
    )
    // ─── POST /api/plans — create plan ───────────────────────────────────────
    .post(
      "/api/plans",
      async ({ body, set }) => {
        try {
          const plan = createPlan(db, {
            id: crypto.randomUUID(),
            slug: body.slug,
            title: body.title,
            status: "draft",
            priority: body.priority ?? 2,
            approvedAt: null,
            completedAt: null,
            sessionId: null,
            overview: body.overview,
            approach: body.approach ?? null,
            complexity: body.complexity ?? 2,
            createdBy: body.createdBy,
            updatedBy: body.createdBy,
            sourceSessionId: null,
            sourceMessageId: null,
            category: body.category ?? null,
            owner: body.owner ?? "foreman",
            metadata: body.metadata ?? {},
            archivedAt: null,
          });
          set.status = 201;
          return plan;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("UNIQUE") && msg.includes("slug")) {
            set.status = 409;
            return { error: "conflict", message: `plan slug "${body.slug}" already exists` };
          }
          if (msg.includes("invalid owner")) {
            set.status = 400;
            return { error: "validation_error", message: msg, field: "owner" };
          }
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      { body: PlanCreateBody },
    )
    // ─── PUT /api/plans/:id — update plan fields ─────────────────────────────
    .put(
      "/api/plans/:id",
      async ({ params: { id }, body, set }) => {
        try {
          const fields: Record<string, unknown> = {};
          if (body.title !== undefined) fields.title = body.title;
          if (body.overview !== undefined) fields.overview = body.overview;
          if (body.approach !== undefined) fields.approach = body.approach;
          if (body.priority !== undefined) fields.priority = body.priority;
          if (body.complexity !== undefined) fields.complexity = body.complexity;
          if (body.category !== undefined) fields.category = body.category;
          if (body.owner !== undefined) fields.owner = body.owner;

          if (Object.keys(fields).length === 0) {
            set.status = 400;
            return {
              error: "validation_error",
              message: "at least one editable field is required",
            };
          }

          const plan = updatePlanFields(db, id, fields as Parameters<typeof updatePlanFields>[2], {
            updatedBy: body.updatedBy,
          });
          if (!plan) {
            set.status = 404;
            return { error: "not_found", message: `plan ${id} not found` };
          }
          return plan;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("invalid owner")) {
            set.status = 400;
            return { error: "validation_error", message: msg, field: "owner" };
          }
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: PlanUpdateBody,
      },
    )
    // ─── PATCH /api/plans/:id/status — transition plan status ────────────────
    .patch(
      "/api/plans/:id/status",
      async ({ params: { id }, body, set }) => {
        try {
          // Validate terminal status requires result
          const terminalStatuses = new Set(["completed", "failed", "abandoned"]);
          if (terminalStatuses.has(body.status) && !body.result && !body.error) {
            set.status = 400;
            return {
              error: "validation_error",
              message: `transitioning to "${body.status}" requires result or error`,
              field: "result",
            };
          }

          const plan = updatePlanStatus(db, id, body.status, {
            updatedBy: body.updatedBy,
          });
          if (!plan) {
            set.status = 404;
            return { error: "not_found", message: `plan ${id} not found` };
          }
          return plan;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("invalid transition") || msg.includes("cannot transition")) {
            set.status = 409;
            return { error: "conflict", message: msg };
          }
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: PlanStatusPatchBody,
      },
    )
    // ─── POST /api/plans/:id/approve — approve plan ──────────────────────────
    .post(
      "/api/plans/:id/approve",
      async ({ params: { id }, body, set }) => {
        try {
          const plan = approvePlan(db, id, { updatedBy: body.updatedBy });
          if (!plan) {
            set.status = 404;
            return { error: "not_found", message: `plan ${id} not found` };
          }
          return plan;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: PlanApproveBody,
      },
    )
    // ─── DELETE /api/plans/:id — delete plan ─────────────────────────────────
    .delete(
      "/api/plans/:id",
      async ({ params: { id }, body, set }) => {
        try {
          const result = deletePlan(db, id, { confirm: body.confirm });
          set.status = 204;
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("not found")) {
            set.status = 404;
            return { error: "not_found", message: msg };
          }
          if (
            msg.includes("draft plan") ||
            msg.includes("active task") ||
            msg.includes("confirm")
          ) {
            set.status = 409;
            return { error: "conflict", message: msg };
          }
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: PlanDeleteBody,
      },
    )
    // ─── POST /api/plans/:id/tasks — create task on plan ─────────────────────
    .post(
      "/api/plans/:id/tasks",
      async ({ params: { id }, body, set }) => {
        try {
          const task = createTask(db, id, {
            description: body.description,
            agent: body.agent,
            files: body.files ?? [],
            complexity: body.complexity ?? 2,
            dependencies: body.dependencies ?? [],
            createdBy: body.agent,
            updatedBy: body.agent,
            sourceSessionId: null,
            sourceMessageId: null,
            reviewedBy: null,
            tokensUsed: null,
            durationMs: null,
            artifacts: [],
            metadata: body.metadata ?? {},
          });
          set.status = 201;
          return task;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("not found") || msg.includes("FOREIGN KEY")) {
            set.status = 404;
            return { error: "not_found", message: `plan ${id} not found` };
          }
          set.status = 500;
          return { error: "internal_error", message: msg };
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: TaskCreateBody,
      },
    );
}
