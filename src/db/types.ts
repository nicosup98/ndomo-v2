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
  /** v6: write-once — JSON snapshot of plan data at creation time */
  originalPlanData?: string | null;
  /** v8: agent that created this plan (distinct from createdBy which is audit user) */
  createdByAgent?: string | null;
  /** v8: agent that last executed work on this plan */
  executedByAgent?: string | null;
  /** v8: session that last executed work on this plan (FK sessions, app-level) */
  executedBySession?: string | null;
  /** v7: files associated with this plan (from plan_files join table) */
  files?: Array<{ filePath: string; role: string }>;
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
  /** v6: write-once — JSON snapshot of task data at creation time */
  originalPlanData?: string | null;
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
  original_plan_data: string | null;
  created_by_agent: string | null;
  executed_by_agent: string | null;
  executed_by_session: string | null;
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
  original_plan_data: string | null;
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
    originalPlanData: r.original_plan_data ?? null,
    createdByAgent: r.created_by_agent ?? null,
    executedByAgent: r.executed_by_agent ?? null,
    executedBySession: r.executed_by_session ?? null,
  };
}

interface PlanFileRow {
  file_path: string;
  role: string;
}

export function planWithFilesFromRow(planRow: unknown, fileRows: unknown[]): Plan {
  const plan = planFromRow(planRow);
  const files = (fileRows as PlanFileRow[]).map((f) => ({
    filePath: f.file_path,
    role: f.role,
  }));
  return { ...plan, files };
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
    originalPlanData: r.original_plan_data ?? null,
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

// ── v13: Ops types ──────────────────────────────────────────────

export type EnvironmentSlug = string
export type ReleaseVersion = string

export type DeploymentStatus = "planned" | "in_progress" | "succeeded" | "failed" | "rolled_back"
export type IncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4"
export type IncidentStatus = "open" | "triaging" | "mitigated" | "resolved" | "postmortem"
export type RollbackStatus = "planned" | "approved" | "dry_run" | "executing" | "success" | "failed" | "cancelled"

export interface Environment {
  id: string
  name: string
  slug: string
  description: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export interface Release {
  id: string
  version: string
  title: string
  notes: string | null
  metadata: Record<string, unknown> | null
  createdAt: number
  archivedAt: number | null
}

export interface Deployment {
  id: string
  releaseId: string
  environmentId: string
  status: DeploymentStatus
  deployedAt: number | null
  createdAt: number
  metadata: Record<string, unknown> | null
}

export interface Incident {
  id: string
  title: string
  severity: IncidentSeverity
  status: IncidentStatus
  summary: string | null
  triggeredByDeploymentId: string | null
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
  metadata: Record<string, unknown> | null
}

export interface RollbackExecution {
  id: string
  deploymentId: string
  incidentId: string | null
  newDeploymentId: string | null
  status: RollbackStatus
  plan: string
  executedAt: number | null
  createdAt: number
  metadata: Record<string, unknown> | null
}

// Insert types (for createIncident/recordRollback helpers)
export interface InsertIncident {
  title: string
  severity: IncidentSeverity
  summary?: string
  triggeredByDeploymentId?: string
  metadata?: Record<string, unknown>
}

export interface InsertRollback {
  deploymentId: string
  incidentId?: string
  newDeploymentId?: string
  status?: RollbackStatus
  plan: string
  metadata?: Record<string, unknown>
}

// Row types (internal, for mappers)
interface EnvironmentRow {
  id: string
  name: string
  slug: string
  description: string | null
  metadata: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

interface ReleaseRow {
  id: string
  version: string
  title: string
  notes: string | null
  metadata: string | null
  created_at: number
  archived_at: number | null
}

interface DeploymentRow {
  id: string
  release_id: string
  environment_id: string
  status: string
  deployed_at: number | null
  created_at: number
  metadata: string | null
}

interface IncidentRow {
  id: string
  title: string
  severity: string
  status: string
  summary: string | null
  triggered_by_deployment_id: string | null
  created_at: number
  updated_at: number
  resolved_at: number | null
  metadata: string | null
}

interface RollbackRow {
  id: string
  deployment_id: string
  incident_id: string | null
  new_deployment_id: string | null
  status: string
  plan: string
  executed_at: number | null
  created_at: number
  metadata: string | null
}

export function environmentFromRow(row: unknown): Environment {
  const r = row as EnvironmentRow
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description ?? null,
    metadata: r.metadata != null ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null,
  }
}

export function releaseFromRow(row: unknown): Release {
  const r = row as ReleaseRow
  return {
    id: r.id,
    version: r.version,
    title: r.title,
    notes: r.notes ?? null,
    metadata: r.metadata != null ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at,
    archivedAt: r.archived_at ?? null,
  }
}

export function deploymentFromRow(row: unknown): Deployment {
  const r = row as DeploymentRow
  return {
    id: r.id,
    releaseId: r.release_id,
    environmentId: r.environment_id,
    status: r.status as DeploymentStatus,
    deployedAt: r.deployed_at ?? null,
    createdAt: r.created_at,
    metadata: r.metadata != null ? JSON.parse(r.metadata) : null,
  }
}

export function incidentFromRow(row: unknown): Incident {
  const r = row as IncidentRow
  return {
    id: r.id,
    title: r.title,
    severity: r.severity as IncidentSeverity,
    status: r.status as IncidentStatus,
    summary: r.summary ?? null,
    triggeredByDeploymentId: r.triggered_by_deployment_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at ?? null,
    metadata: r.metadata != null ? JSON.parse(r.metadata) : null,
  }
}

export function rollbackFromRow(row: unknown): RollbackExecution {
  const r = row as RollbackRow
  return {
    id: r.id,
    deploymentId: r.deployment_id,
    incidentId: r.incident_id ?? null,
    newDeploymentId: r.new_deployment_id ?? null,
    status: r.status as RollbackStatus,
    plan: r.plan,
    executedAt: r.executed_at ?? null,
    createdAt: r.created_at,
    metadata: r.metadata != null ? JSON.parse(r.metadata) : null,
  }
}

// ── v14: Analyses ───────────────────────────────────────────────

/**
 * Severity classification for analysis findings.
 * Mirrors the existing observed convention in stored findings_json.
 */
export type FindingSeverity = "high" | "medium" | "low" | "info";

/**
 * Agent boundary contract for analysis findings (v15):
 *
 * - `observation` (REQUIRED): a factual, descriptive statement. Every
 *   agent — ranger, foreman, craftsman, smiths — MAY emit observation.
 *   Observations do not prescribe action; they describe what exists.
 *
 * - `proposedAction` (OPTIONAL): a prescriptive recommendation only
 *   decision-capable agents may emit. Concretely:
 *     • ranger is EXCLUDED. Validated at write time by
 *       `validateAnalysisFindings()` in src/db/analyses.ts.
 *     • foreman, craftsman, warden, smiths, sage, etc. MAY emit it
 *       when they have explicit decision/architectural authority.
 *
 * The boundary enforces ranger's "observation-only" role and keeps
 * prescriptive planning in the hands of decision-capable agents.
 */
export interface Finding {
  severity: FindingSeverity;
  /** Optional file:line or code location the finding refers to. */
  location?: string;
  /** Factual statement. Required for all agents. */
  observation: string;
  /**
   * Prescriptive recommendation. OPTIONAL — and FORBIDDEN when agent === 'ranger'.
   * See agent boundary contract above.
   */
  proposedAction?: string;
  /** Optional effort estimate (e.g. 'small', 'medium', 'large'). */
  effort?: string;
  /** Optional impact estimate (e.g. 'low', 'medium', 'high'). */
  impact?: string;
}

/**
 * Analysis row. `findingsJson` is the serialized JSON array of {@link Finding}
 * entries stored in the analyses table (TEXT column). The DB layer keeps it
 * as a string for query/index flexibility; consumers parse on read.
 */
export interface Analysis {
  id: string;
  slug: string;
  title: string;
  projectPath: string;
  summary: string;
  /** JSON array of {@link Finding}. Parse with JSON.parse(findingsJson) before use. */
  findingsJson: string;
  sourcePlanId: string | null;
  agent: string;
  sessionId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface InsertAnalysis {
  slug: string;
  title: string;
  projectPath: string;
  summary?: string;
  findingsJson?: string;
  sourcePlanId?: string | null;
  agent?: string;
  sessionId?: string | null;
  createdBy?: string | null;
}

export interface AnalysisRow {
  id: string;
  slug: string;
  title: string;
  project_path: string;
  summary: string;
  findings_json: string;
  source_plan_id: string | null;
  agent: string;
  session_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function analysisFromRow(row: unknown): Analysis {
  const r = row as AnalysisRow;
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    projectPath: r.project_path,
    summary: r.summary,
    findingsJson: r.findings_json,
    sourcePlanId: r.source_plan_id ?? null,
    agent: r.agent,
    sessionId: r.session_id ?? null,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at ?? null,
  };
}
