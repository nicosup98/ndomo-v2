/**
 * ndomo DB — Type definitions for plans, tasks, and sessions.
 *
 * All interfaces use camelCase. Mapper functions convert snake_case
 * SQLite rows into typed objects using nullish coalescing for nullable
 * fields and JSON.parse for serialized columns.
 */

export type PlanStatus = "draft" | "approved" | "executing" | "completed" | "failed" | "abandoned";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked";

export type PlanCategory = "feature" | "refactor" | "bugfix" | "docs" | "infra";

export type SessionOutcome = "success" | "partial" | "failed" | "abandoned";

export interface PlanMetadata {
  category?: PlanCategory;
  externalRefs?: {
    githubPrUrl?: string;
    jiraTicket?: string;
  };
}

export interface TaskMetadata {
  reviewedBy?: string;
  tokensUsed?: number;
  durationMs?: number;
  artifacts?: string[];
}

export interface SessionMetadata {
  outcome?: SessionOutcome;
  metrics?: {
    totalTokens?: number;
    totalTasks?: number;
    totalDurationMs?: number;
  };
}

export interface Plan {
  id: string;
  slug: string;
  title: string;
  status: PlanStatus;
  priority: number;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  completedAt: number | null;
  /** @see sessions.id — foreign key constraint enforced at app level (v3 Fix #1) */
  sessionId: string | null;
  overview: string;
  approach: string | null;
  complexity: number;
  createdBy: string;
  updatedBy: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  category: PlanCategory | null;
  metadata: PlanMetadata;
  /** v5: soft delete timestamp (null = active, number = archived epoch ms) */
  archivedAt: number | null;
}

export interface PlanTask {
  id: string;
  planId: string;
  orderIndex: number;
  description: string;
  agent: string;
  files: string[];
  complexity: number;
  status: TaskStatus;
  startedAt: number | null;
  completedAt: number | null;
  result: string | null;
  error: string | null;
  dependencies: string[];
  createdBy: string;
  updatedBy: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  reviewedBy: string | null;
  tokensUsed: number | null;
  durationMs: number | null;
  artifacts: string[];
  metadata: TaskMetadata;
  /** v5: soft delete timestamp (null = active, number = archived epoch ms) */
  archivedAt: number | null;
}

export interface Session {
  id: string;
  startedAt: number;
  endedAt: number | null;
  lastCheckpoint: number | null;
  planId: string | null;
  goal: string;
  state: Record<string, unknown>;
  agentHistory: Array<{
    agent: string;
    taskId: string | null;
    startedAt: number;
    endedAt: number | null;
  }>;
  keyDecisions: string | null;
  createdBy: string;
  sourceMessageId: string | null;
  parentSessionId: string | null;
  outcome: SessionOutcome | null;
  metadata: SessionMetadata;
  /** v5: soft delete timestamp (null = active, number = archived epoch ms) */
  archivedAt: number | null;
}

// ─── Row mappers ─────────────────────────────────────────────────────────────

interface PlanRow {
  id: string;
  slug: string;
  title: string;
  status: string;
  priority: number;
  created_at: number;
  updated_at: number;
  approved_at: number | null;
  completed_at: number | null;
  session_id: string | null;
  overview: string;
  approach: string | null;
  complexity: number;
  metadata: string | null;
  created_by: string;
  updated_by: string;
  source_session_id: string | null;
  source_message_id: string | null;
  category: string | null;
  archived_at: number | null;
}

interface TaskRow {
  id: string;
  plan_id: string;
  order_index: number;
  description: string;
  agent: string;
  files: string;
  complexity: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  error: string | null;
  dependencies: string;
  metadata: string | null;
  created_by: string;
  updated_by: string;
  source_session_id: string | null;
  source_message_id: string | null;
  reviewed_by: string | null;
  tokens_used: number | null;
  duration_ms: number | null;
  artifacts: string;
  archived_at: number | null;
}

interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  last_checkpoint: number | null;
  plan_id: string | null;
  goal: string;
  state: string;
  agent_history: string;
  key_decisions: string | null;
  metadata: string | null;
  created_by: string;
  source_message_id: string | null;
  parent_session_id: string | null;
  outcome: string | null;
  archived_at: number | null;
}

export function planFromRow(row: unknown): Plan {
  const r = row as PlanRow;
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status as PlanStatus,
    priority: r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at ?? null,
    completedAt: r.completed_at ?? null,
    sessionId: r.session_id ?? null,
    overview: r.overview,
    approach: r.approach ?? null,
    complexity: r.complexity,
    createdBy: r.created_by ?? "unknown",
    updatedBy: r.updated_by ?? "unknown",
    sourceSessionId: r.source_session_id ?? null,
    sourceMessageId: r.source_message_id ?? null,
    category: (r.category ?? null) as PlanCategory | null,
    metadata: (r.metadata != null ? JSON.parse(r.metadata) : {}) as PlanMetadata,
    archivedAt: r.archived_at ?? null,
  };
}

export function taskFromRow(row: unknown): PlanTask {
  const r = row as TaskRow;
  return {
    id: r.id,
    planId: r.plan_id,
    orderIndex: r.order_index,
    description: r.description,
    agent: r.agent,
    files: (JSON.parse(r.files) as string[]) ?? [],
    complexity: r.complexity,
    status: r.status as TaskStatus,
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    result: r.result ?? null,
    error: r.error ?? null,
    dependencies: (JSON.parse(r.dependencies) as string[]) ?? [],
    createdBy: r.created_by ?? "unknown",
    updatedBy: r.updated_by ?? "unknown",
    sourceSessionId: r.source_session_id ?? null,
    sourceMessageId: r.source_message_id ?? null,
    reviewedBy: r.reviewed_by ?? null,
    tokensUsed: r.tokens_used ?? null,
    durationMs: r.duration_ms ?? null,
    artifacts: (JSON.parse(r.artifacts) as string[]) ?? [],
    metadata: (r.metadata != null ? JSON.parse(r.metadata) : {}) as TaskMetadata,
    archivedAt: r.archived_at ?? null,
  };
}

export function sessionFromRow(row: unknown): Session {
  const r = row as SessionRow;
  return {
    id: r.id,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    lastCheckpoint: r.last_checkpoint ?? null,
    planId: r.plan_id ?? null,
    goal: r.goal,
    state: (JSON.parse(r.state) as Record<string, unknown>) ?? {},
    agentHistory: (JSON.parse(r.agent_history) as Session["agentHistory"]) ?? [],
    keyDecisions: r.key_decisions ?? null,
    createdBy: r.created_by ?? "unknown",
    sourceMessageId: r.source_message_id ?? null,
    parentSessionId: r.parent_session_id ?? null,
    outcome: (r.outcome ?? null) as SessionOutcome | null,
    metadata: (r.metadata != null ? JSON.parse(r.metadata) : {}) as SessionMetadata,
    archivedAt: r.archived_at ?? null,
  };
}
