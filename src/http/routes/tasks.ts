// ─── Tasks Routes ─────────────────────────────────────────────────────────────
/**
 * GET /api/tasks           — list tasks by planId (required), optional: status
 * GET /api/tasks/search    — FTS5 search (required: q, optional: limit)
 * GET /api/tasks/:id       — get single task by id
 */
import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import { getTask, listTasksByPlan, searchTasks } from "../../db/tasks.ts";
import type { TaskStatus } from "../../db/types.ts";

const TaskStatusValues = ["pending", "running", "done", "failed", "blocked"] as const;

export function tasksRoute(db: Database) {
  return new Elysia({ name: "tasks" })
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
    );
}
