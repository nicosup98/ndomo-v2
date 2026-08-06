/**
 * ndomo web — API types mirroring backend src/db/types.ts exactly.
 *
 * All fields camelCase. Nullable fields use `T | null` (not optional).
 * Plan.files only present on detail endpoint (GET /api/plans/:id).
 */

// ─── Enums ──────────────────────────────────────────────────────────────────

export type PlanStatus = "draft" | "approved" | "executing" | "completed" | "failed" | "abandoned";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked";
export type PlanCategory = "feature" | "refactor" | "bugfix" | "docs" | "infra";

// ─── Plan ───────────────────────────────────────────────────────────────────

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
  archivedAt: number | null;
  originalPlanData?: string | null;
  createdByAgent?: string | null;
  executedByAgent?: string | null;
  executedBySession?: string | null;
  files?: Array<{ filePath: string; role: string }>;
}

export interface PlanMetadata {
  category?: PlanCategory;
  externalRefs?: {
    githubPrUrl?: string;
    jiraTicket?: string;
  };
}

// ─── Task ───────────────────────────────────────────────────────────────────

export interface Task {
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
  archivedAt: number | null;
  originalPlanData?: string | null;
}

export interface TaskMetadata {
  reviewedBy?: string;
  tokensUsed?: number;
  durationMs?: number;
  artifacts?: string[];
}

// ─── Session ────────────────────────────────────────────────────────────────

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
  outcome: string | null;
  metadata: SessionMetadata;
  archivedAt: number | null;
}

export interface SessionMetadata {
  outcome?: string;
  metrics?: {
    totalTokens?: number;
    totalTasks?: number;
    totalDurationMs?: number;
  };
}

// ─── Health ─────────────────────────────────────────────────────────────────

export interface Health {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
  timestamp: number;
  dbHealthy: boolean;
}

// ─── API Error ──────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  message?: string;
  status?: number;
}

// ─── Write body types (mirror src/http/schemas.ts) ───────────────────────────

export type PlanOwner = "foreman" | "craftsman" | "warden";

export interface PlanCreateBody {
  slug: string;
  title: string;
  overview: string;
  approach?: string;
  priority?: number;
  complexity?: number;
  category?: PlanCategory;
  owner?: PlanOwner;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface PlanUpdateBody {
  title?: string;
  overview?: string;
  approach?: string;
  priority?: number;
  complexity?: number;
  category?: PlanCategory;
  owner?: PlanOwner;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface PlanStatusPatch {
  status: PlanStatus;
  updatedBy: string;
  result?: string;
  error?: string;
}

export interface PlanApproveBody {
  updatedBy: string;
}

export interface PlanDeleteBody {
  confirm: boolean;
  updatedBy: string;
}

export interface TaskCreateBody {
  description: string;
  agent: string;
  files?: string[];
  complexity?: number;
  dependencies?: string[];
  metadata?: Record<string, unknown>;
}

export interface TaskUpdateBody {
  description?: string;
  files?: string[];
  complexity?: number;
  metadata?: Record<string, unknown>;
  updatedBy: string;
}

export interface TaskStatusPatch {
  status: TaskStatus;
  updatedBy: string;
  result?: string;
  error?: string;
}

export interface TaskReassignBody {
  agent: string;
  updatedBy: string;
}

export interface TaskDeleteBody {
  confirm: boolean;
  updatedBy: string;
}
