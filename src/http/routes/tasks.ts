// ─── Tasks Routes ─────────────────────────────────────────────────────────────
/**
 * GET   /api/tasks                  — list tasks by planId (required), optional: status
 * GET   /api/tasks/search           — FTS5 search (required: q, optional: limit)
 * GET   /api/tasks/:id              — get single task by id
 * POST  /api/plans/:planId/tasks    — create a new task on a plan
 * PUT   /api/tasks/:id              — update task fields (partial)
 * PATCH /api/tasks/:id/status       — transition task status (gated when verificationRequired, v17/T1)
 * POST  /api/tasks/:id/verify       — record verifier verdict (v17/T1)
 * PATCH /api/tasks/:id/reassign     — reassign task to a different agent
 * DELETE /api/tasks/:id             — delete a task (with guards)
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
  deleteTask,
  getTask,
  listTasksByPlan,
  reassignTask,
  recordTaskVerification,
  searchTasks,
  updateTaskFields,
  updateTaskStatus,
} from "../../db/tasks.ts";
import type { TaskStatus } from "../../db/types.ts";
import {
  TaskDeleteBody,
  TaskReassignBody,
  TaskStatusPatchBody,
  TaskStatusValues,
  TaskUpdateBody,
  TaskVerifyBody,
} from "../schemas.ts";

export function tasksRoute(db: Database) {
  return (
    new Elysia({ name: "tasks" })
      // ─── GET routes (existing) ───────────────────────────────────────────────
      .get(
        "/api/tasks",
        async ({ query, set }) => {
          if (!query.planId) {
            set.status = 422;
            return { error: "validation_error", message: "planId is required" };
          }
          const opts: { status?: TaskStatus } = {};
          if (query.status) opts.status = query.status as TaskStatus;
          return listTasksByPlan(db, query.planId, opts);
        },
        {
          query: t.Object({
            planId: t.String(),
            status: t.Optional(t.UnionEnum(TaskStatusValues)),
          }),
        },
      )
      .get(
        "/api/tasks/search",
        async ({ query }) => {
          return searchTasks(db, query.q, query.limit ?? 20);
        },
        {
          query: t.Object({
            q: t.String({ minLength: 1 }),
            limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
          }),
        },
      )
      .get(
        "/api/tasks/:id",
        async ({ params: { id }, set }) => {
          const task = getTask(db, id);
          if (!task) {
            set.status = 404;
            return { error: "not_found", message: `task ${id} not found` };
          }
          return task;
        },
        {
          params: t.Object({ id: t.String() }),
        },
      )
      // ─── PUT /api/tasks/:id — update task fields ─────────────────────────────
      .put(
        "/api/tasks/:id",
        async ({ params: { id }, body, set }) => {
          try {
            const fields: Record<string, unknown> = {};
            if (body.description !== undefined) fields.description = body.description;
            if (body.files !== undefined) fields.files = body.files;
            if (body.complexity !== undefined) fields.complexity = body.complexity;
            if (body.metadata !== undefined) fields.metadata = body.metadata;

            if (Object.keys(fields).length === 0) {
              set.status = 400;
              return {
                error: "validation_error",
                message: "at least one editable field is required",
              };
            }

            const task = updateTaskFields(
              db,
              id,
              fields as Parameters<typeof updateTaskFields>[2],
              {
                updatedBy: body.updatedBy,
              },
            );
            if (!task) {
              set.status = 404;
              return { error: "not_found", message: `task ${id} not found` };
            }
            return task;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            set.status = 500;
            return { error: "internal_error", message: msg };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: TaskUpdateBody,
        },
      )
      // ─── PATCH /api/tasks/:id/status — transition task status ────────────────
      .patch(
        "/api/tasks/:id/status",
        async ({ params: { id }, body, set }) => {
          try {
            const fields: {
              result?: string;
              error?: string;
              force?: boolean;
              forceReason?: string;
            } = {};
            if (body.result !== undefined) fields.result = body.result;
            if (body.error !== undefined) fields.error = body.error;
            if (body.force !== undefined) fields.force = body.force;
            if (body.forceReason !== undefined) fields.forceReason = body.forceReason;

            const result = updateTaskStatus(db, id, body.status, fields, body.updatedBy);
            if (!result) {
              set.status = 404;
              return { error: "not_found", message: `task ${id} not found` };
            }
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("requires verification")) {
              // T1 execution gate fired — tell the client exactly how to proceed.
              set.status = 409;
              return {
                error: "verification_required",
                message: msg,
                hint: "POST /api/tasks/:id/verify with verdict='passed' (inspector only) or re-issue with force=true + non-blank forceReason to waive.",
              };
            }
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
          body: TaskStatusPatchBody,
        },
      )
      // ─── POST /api/tasks/:id/verify — record verifier verdict (v17/T1) ───────
      .post(
        "/api/tasks/:id/verify",
        async ({ params: { id }, body, set }) => {
          try {
            // Normalize result: accept object OR JSON string.
            let resultObj: Record<string, unknown> | undefined;
            if (body.result !== undefined && body.result !== null) {
              if (typeof body.result === "string") {
                try {
                  const parsed = JSON.parse(body.result);
                  resultObj =
                    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                      ? (parsed as Record<string, unknown>)
                      : { value: parsed };
                } catch {
                  resultObj = { raw: body.result };
                }
              } else if (typeof body.result === "object") {
                resultObj = body.result as Record<string, unknown>;
              }
            }
            // verifiedBy: explicit body field wins; otherwise fall back to updatedBy;
            // the inspector-only 'passed' rule is enforced inside recordTaskVerification.
            const verifiedBy = body.verifiedBy ?? "unknown";
            const updated = recordTaskVerification(db, id, body.verdict, resultObj, verifiedBy, {
              ...(body.force !== undefined ? { force: body.force } : {}),
              ...(body.forceReason !== undefined ? { forceReason: body.forceReason } : {}),
              ...(body.reason !== undefined ? { reason: body.reason } : {}),
            });
            return updated;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("task not found")) {
              set.status = 404;
              return { error: "not_found", message: msg };
            }
            if (
              msg.includes("invalid verification verdict") ||
              msg.includes("only 'inspector'") ||
              msg.includes("requires a non-blank reason") ||
              msg.includes("already has verification_status='passed'")
            ) {
              set.status = 409;
              return { error: "verification_conflict", message: msg };
            }
            set.status = 500;
            return { error: "internal_error", message: msg };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: TaskVerifyBody,
        },
      )
      // ─── PATCH /api/tasks/:id/reassign — reassign task agent ─────────────────
      .patch(
        "/api/tasks/:id/reassign",
        async ({ params: { id }, body, set }) => {
          try {
            const task = reassignTask(db, id, body.agent, { updatedBy: body.updatedBy });
            if (!task) {
              set.status = 404;
              return { error: "not_found", message: `task ${id} not found` };
            }
            return task;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("invalid agent")) {
              set.status = 400;
              return { error: "validation_error", message: msg, field: "agent" };
            }
            set.status = 500;
            return { error: "internal_error", message: msg };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: TaskReassignBody,
        },
      )
      // ─── DELETE /api/tasks/:id — delete task ─────────────────────────────────
      .delete(
        "/api/tasks/:id",
        async ({ params: { id }, body, set }) => {
          try {
            const result = deleteTask(db, id, {
              confirm: body.confirm,
              updatedBy: body.updatedBy,
            });
            set.status = 204;
            return result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("not found")) {
              set.status = 404;
              return { error: "not_found", message: msg };
            }
            if (msg.includes("running task") || msg.includes("confirm")) {
              set.status = 409;
              return { error: "conflict", message: msg };
            }
            set.status = 500;
            return { error: "internal_error", message: msg };
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: TaskDeleteBody,
        },
      )
  );
}
