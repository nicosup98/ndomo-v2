// ─── Shared Schemas ──────────────────────────────────────────────────────────
/**
 * Shared Elysia `t` schemas + plain TS type interfaces for plan/task validation.
 *
 * Used by HTTP routes (Elysia `t` objects) and CLI (plain TS validators).
 * No zod dependency — Elysia `t` is TypeBox-compatible and sufficient.
 */

import { t } from "elysia";

// ─── Enum values ─────────────────────────────────────────────────────────────

export const PlanStatusValues = [
  "draft",
  "approved",
  "executing",
  "completed",
  "failed",
  "abandoned",
] as const;

export const TaskStatusValues = [
  "pending",
  "running",
  "done",
  "failed",
  "blocked",
] as const;

export const PlanOwnerValues = ["foreman", "craftsman", "warden"] as const;

export const PlanCategoryValues = ["feature", "refactor", "bugfix", "docs", "infra"] as const;

// ─── Plan schemas ────────────────────────────────────────────────────────────

/** POST /api/plans body */
export const PlanCreateBody = t.Object({
  slug: t.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+$" }),
  title: t.String({ minLength: 1, maxLength: 200 }),
  overview: t.String({ minLength: 1 }),
  approach: t.Optional(t.String()),
  priority: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  complexity: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  category: t.Optional(t.UnionEnum(PlanCategoryValues)),
  owner: t.Optional(t.UnionEnum(PlanOwnerValues)),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
  createdBy: t.String({ minLength: 1 }),
});

export type PlanCreateBodyT = {
  slug: string;
  title: string;
  overview: string;
  approach?: string;
  priority?: number;
  complexity?: number;
  category?: "feature" | "refactor" | "bugfix" | "docs" | "infra";
  owner?: "foreman" | "craftsman" | "warden";
  metadata?: Record<string, unknown>;
  createdBy: string;
};

/** PUT /api/plans/:id body */
export const PlanUpdateBody = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  overview: t.Optional(t.String({ minLength: 1 })),
  approach: t.Optional(t.String()),
  priority: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  complexity: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  category: t.Optional(t.UnionEnum(PlanCategoryValues)),
  owner: t.Optional(t.UnionEnum(PlanOwnerValues)),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
  updatedBy: t.String({ minLength: 1 }),
});

export type PlanUpdateBodyT = {
  title?: string;
  overview?: string;
  approach?: string;
  priority?: number;
  complexity?: number;
  category?: "feature" | "refactor" | "bugfix" | "docs" | "infra";
  owner?: "foreman" | "craftsman" | "warden";
  metadata?: Record<string, unknown>;
  updatedBy: string;
};

/** PATCH /api/plans/:id/status body */
export const PlanStatusPatchBody = t.Object({
  status: t.UnionEnum(PlanStatusValues),
  updatedBy: t.String({ minLength: 1 }),
  result: t.Optional(t.String()),
  error: t.Optional(t.String()),
});

export type PlanStatusPatchBodyT = {
  status: "draft" | "approved" | "executing" | "completed" | "failed" | "abandoned";
  updatedBy: string;
  result?: string;
  error?: string;
};

/** POST /api/plans/:id/approve body */
export const PlanApproveBody = t.Object({
  updatedBy: t.String({ minLength: 1 }),
});

export type PlanApproveBodyT = {
  updatedBy: string;
};

/** DELETE /api/plans/:id body */
export const PlanDeleteBody = t.Object({
  confirm: t.Boolean(),
  updatedBy: t.String({ minLength: 1 }),
});

export type PlanDeleteBodyT = {
  confirm: boolean;
  updatedBy: string;
};

// ─── Task schemas ────────────────────────────────────────────────────────────

/** POST /api/plans/:planId/tasks body */
export const TaskCreateBody = t.Object({
  description: t.String({ minLength: 1 }),
  agent: t.String({ minLength: 1 }),
  files: t.Optional(t.Array(t.String())),
  complexity: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  dependencies: t.Optional(t.Array(t.String())),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
});

export type TaskCreateBodyT = {
  description: string;
  agent: string;
  files?: string[];
  complexity?: number;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
};

/** PUT /api/tasks/:id body */
export const TaskUpdateBody = t.Object({
  description: t.Optional(t.String({ minLength: 1 })),
  files: t.Optional(t.Array(t.String())),
  complexity: t.Optional(t.Number({ minimum: 1, maximum: 5 })),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
  updatedBy: t.String({ minLength: 1 }),
});

export type TaskUpdateBodyT = {
  description?: string;
  files?: string[];
  complexity?: number;
  metadata?: Record<string, unknown>;
  updatedBy: string;
};

/** PATCH /api/tasks/:id/status body */
export const TaskStatusPatchBody = t.Object({
  status: t.UnionEnum(TaskStatusValues),
  updatedBy: t.String({ minLength: 1 }),
  result: t.Optional(t.String()),
  error: t.Optional(t.String()),
});

export type TaskStatusPatchBodyT = {
  status: "pending" | "running" | "done" | "failed" | "blocked";
  updatedBy: string;
  result?: string;
  error?: string;
};

/** PATCH /api/tasks/:id/reassign body */
export const TaskReassignBody = t.Object({
  agent: t.String({ minLength: 1 }),
  updatedBy: t.String({ minLength: 1 }),
});

export type TaskReassignBodyT = {
  agent: string;
  updatedBy: string;
};

/** DELETE /api/tasks/:id body */
export const TaskDeleteBody = t.Object({
  confirm: t.Boolean(),
  updatedBy: t.String({ minLength: 1 }),
});

export type TaskDeleteBodyT = {
  confirm: boolean;
  updatedBy: string;
};
