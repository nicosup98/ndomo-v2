/**
 * Agent routing logic for the ndomo orchestrator.
 * Pure functions that determine which specialist agent handles a task.
 *
 * Routing is hybrid: when JEV (TypeSafe AI) is configured and available, its
 * classification overrides agent/type/risk; otherwise the heuristic rules below
 * apply unchanged. See ./jev.ts.
 */

import type { JevConfig } from "../config/schema.ts";
import type { AgentHistory } from "./agent-history.ts";
import { bucketForTask, scoreAgentForBucket } from "./agent-history.ts";
import type { JevClassifierDeps, JevRouteDecision } from "./jev.ts";
import { classifyRouteWithJev } from "./jev.ts";

/** A ranked routing option surfaced for transparency (advisory, never blocking). */
export interface RoutingAlternative {
  /** Candidate agent that was not chosen. */
  agent: string;
  /** History score in [0,1]. */
  score: number;
  /** Short evidence summary (bucket + sample counts). */
  reason: string;
}

/** Decision returned by the scheduler after routing a task. */
export interface RoutingDecision {
  /** Target agent identifier (e.g. "scout", "go-smith", "sage"). */
  agent: string;
  /** Human-readable reason for the routing choice. */
  reason: string;
  /** Whether this task can run alongside other parallel tasks. */
  parallel: boolean;
  /** Task IDs that must complete before this one starts. */
  dependencies: string[];
  /** Agent that should review output before merge (advisory, not blocking). */
  requiresReview?: string;
  /** Which classifier produced the decision (hybrid routing audit trail). */
  source?: "jev" | "rules" | "history" | "hybrid";
  /** Confidence in the chosen agent, in [0,1] (score margin between top candidates). */
  confidence?: number;
  /** Next-best agents by history score (advisory, max 3). */
  alternatives?: RoutingAlternative[];
  /** Human-readable factor breakdown of the history ranking. */
  explain?: string[];
  /** True when the chosen agent rests on the global prior only (cold start). */
  fallback?: boolean;
  /** True when epsilon-exploration forced the second-best candidate. */
  explore?: boolean;
}

/** Incoming task request from the foreman. */
export interface TaskRequest {
  /** Natural language description of what to do. */
  description: string;
  /** Detected or declared tech stack. */
  stack?: "go" | "vue" | "js" | "python" | "zig" | "generic" | "unknown";
  /** Category of work. */
  type: "implement" | "explore" | "research" | "design" | "debug" | "audit" | "document" | "debate";
  /** Files targeted by this task (for conflict detection). */
  files?: string[];
  /** Risk assessment from the foreman. */
  risk: "low" | "medium" | "high";
}

/** Maps known tech stacks to their specialist agent IDs. */
const STACK_AGENTS: Record<string, string> = {
  go: "go-smith",
  vue: "vue-smith",
  js: "js-smith",
  python: "python-smith",
  zig: "zig-smith",
};

/**
 * Heuristic routing rules (JEV-free). This is the original `routeTask` logic;
 * it is kept pure and synchronous so the hybrid router can reuse it for the
 * fields JEV does not classify (parallelism, dependencies, review advisory).
 *
 * Priority order:
 *  1. Explore  → scout
 *  2. Research → scribe
 *  3. Design + vue stack → painter
 *  4. Audit   → inspector
 *  5. Document → chronicler
 *  6. Debate  → guild
 *  7. Debug + high risk → sage
 *  8. Implement + known stack → stack-smith
 *  9. Implement + generic/unknown → smith
 * 10. High risk + implement → sage (advisory) + stack-smith
 * 11. Default → smith
 */
function routeTaskWithRules(task: TaskRequest): RoutingDecision {
  const { type, stack, risk } = task;

  // 1. Explore → scout
  if (type === "explore") {
    return {
      agent: "scout",
      reason: "Exploration task delegated to scout for codebase reconnaissance.",
      parallel: true,
      dependencies: [],
    };
  }

  // 2. Research → scribe
  if (type === "research") {
    return {
      agent: "scribe",
      reason: "Research task delegated to scribe for documentation and investigation.",
      parallel: true,
      dependencies: [],
    };
  }

  // 3. Design + vue → painter
  if (type === "design" && stack === "vue") {
    return {
      agent: "painter",
      reason: "Vue design task delegated to painter for UI/UX composition.",
      parallel: true,
      dependencies: [],
    };
  }

  // 4. Audit → inspector
  if (type === "audit") {
    return {
      agent: "inspector",
      reason: "Audit task delegated to inspector for code quality review.",
      parallel: true,
      dependencies: [],
    };
  }

  // 5. Document → chronicler
  if (type === "document") {
    return {
      agent: "chronicler",
      reason: "Documentation task delegated to chronicler.",
      parallel: true,
      dependencies: [],
    };
  }

  // 6. Debate → guild
  if (type === "debate") {
    return {
      agent: "guild",
      reason: "Debate task delegated to guild for multi-perspective analysis.",
      parallel: false,
      dependencies: [],
    };
  }

  // 7. Debug + high risk → sage
  if (type === "debug" && risk === "high") {
    return {
      agent: "sage",
      reason: "High-risk debug task escalated to sage for careful analysis.",
      parallel: false,
      dependencies: [],
    };
  }

  // 8. Implement + known stack → stack-smith
  if (type === "implement" && stack && stack in STACK_AGENTS) {
    const stackAgent = STACK_AGENTS[stack];
    if (!stackAgent) {
      // Should never happen due to the check above, but satisfies strict nulls
      return {
        agent: "smith",
        reason: "Stack lookup failed, falling back to generic smith.",
        parallel: true,
        dependencies: [],
      };
    }

    // 10. High risk implement → sage advisory + stack-smith
    if (risk === "high") {
      return {
        agent: stackAgent,
        reason: `High-risk ${stack} implementation. Sage should review before merge.`,
        parallel: true,
        dependencies: [],
        requiresReview: "sage",
      };
    }

    return {
      agent: stackAgent,
      reason: `${stack} implementation delegated to ${stackAgent}.`,
      parallel: true,
      dependencies: [],
    };
  }

  // 9. Implement + generic/unknown → smith
  if (type === "implement") {
    return {
      agent: "smith",
      reason: "Generic implementation task delegated to smith.",
      parallel: true,
      dependencies: [],
    };
  }

  // 11. Default → smith
  return {
    agent: "smith",
    reason: "No specific routing rule matched, defaulting to smith.",
    parallel: true,
    dependencies: [],
  };
}

/** Options for the hybrid router. */
export interface RouteOptions {
  /**
   * JEV config. Omit to skip JEV entirely: routing is pure heuristic and
   * no network access is attempted (backwards-compatible behavior).
   */
  jev?: JevConfig;
  /** Injectable JEV dependencies (tests). */
  jevDeps?: JevClassifierDeps;
  /**
   * Outcome history used to rerank candidates (history-aware routing). Omit for
   * pure rules/JEV behavior: the legacy output shape is returned untouched.
   */
  history?: AgentHistory | null;
  /** Injectable RNG for the epsilon-exploration branch (tests). Defaults to Math.random. */
  random?: (() => number) | undefined;
  /** Exploration probability in [0,1] (default 0.15). Set 0 to disable. */
  epsilon?: number | undefined;
}

/** Default epsilon-exploration probability (feedback-loop mitigation). */
export const DEFAULT_EXPLORE_EPSILON = 0.15;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Heuristic candidate pool for history ranking: the rules agent first, then the
 * JEV agent (when present), then role-specific siblings for the task type.
 */
function historyCandidates(
  primary: string,
  jevAgent: string | undefined,
  task: TaskRequest,
): string[] {
  const list: string[] = [];
  const push = (agent: string | undefined): void => {
    if (agent && !list.includes(agent)) list.push(agent);
  };
  push(jevAgent);
  push(primary);
  const stackAgent =
    task.stack && task.stack in STACK_AGENTS ? STACK_AGENTS[task.stack] : undefined;
  switch (task.type) {
    case "implement":
      push(stackAgent);
      push("craftsman");
      push("smith");
      break;
    case "explore":
      push("ranger");
      break;
    case "research":
      push("scout");
      break;
    case "design":
      push(stackAgent);
      push("painter");
      break;
    case "debug":
      push("sage");
      push("craftsman");
      break;
    case "audit":
      push("critic");
      break;
    case "document":
      push("scribe");
      break;
    case "debate":
      push("sage");
      break;
  }
  return list.slice(0, 5);
}

interface ScoredCandidate {
  agent: string;
  score: number;
  index: number;
  cellN: number;
  agentN: number;
  pooled: number;
  recency: number;
  verify: number;
  duration: number;
  confidence: number;
}

/** Legacy output shape (rules/JEV only, no history). */
function legacyDecision(
  base: RoutingDecision,
  jev: JevRouteDecision | null,
  effective: TaskRequest,
): RoutingDecision {
  if (jev?.agent) {
    return {
      ...base,
      agent: jev.agent,
      reason: `JEV (TypeSafe) classified as ${effective.type}/${effective.risk}; routed to ${jev.agent}.`,
      source: "jev",
    };
  }
  return { ...base, source: jev ? "jev" : "rules" };
}

/**
 * History-aware reranking: score the heuristic/JEV candidate pool against the
 * outcome history, pick the winner (with optional epsilon-exploration) and
 * return an enriched decision (confidence/alternatives/explain/fallback).
 */
function routeWithHistory(
  task: TaskRequest,
  base: RoutingDecision,
  jev: JevRouteDecision | null,
  options: RouteOptions,
): RoutingDecision {
  const history = options.history;
  if (!history) return legacyDecision(base, jev, task);

  const bucket = bucketForTask(task.type, task.files, task.stack);
  const now = history.generatedAt;
  const complexity = jev?.complexity;
  const highComplexity = complexity !== undefined && complexity >= 0.66;

  const candidates = historyCandidates(base.agent, jev?.agent, task);
  const scored: ScoredCandidate[] = candidates
    .map((agent, index) => {
      const components = scoreAgentForBucket(history, agent, bucket, {
        ...(complexity !== undefined ? { complexity } : {}),
        ...(jev?.confidence !== undefined && jev?.agent === agent
          ? { jevConfidence: jev.confidence }
          : {}),
        now,
      });
      return {
        agent,
        score: components.score,
        cellN: components.cellN,
        agentN: components.agentN,
        pooled: components.pooled,
        recency: components.recency,
        verify: components.verify,
        duration: components.duration,
        confidence: components.confidence,
        index,
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const first = scored[0];
  if (!first) return legacyDecision(base, jev, task);
  const second = scored[1];

  const epsilon = options.epsilon ?? DEFAULT_EXPLORE_EPSILON;
  const random = options.random ?? Math.random;
  const explore = epsilon > 0 && second !== undefined && random() < epsilon;
  const chosen = explore && second ? second : first;
  const runnerUp = scored.find((candidate) => candidate.agent !== chosen.agent);

  const top = first.score;
  const next = runnerUp?.score ?? 0;
  const confidence = runnerUp ? (top + next > 0 ? top / (top + next) : 1) : 1;

  const reason = explore
    ? `History explore: ${chosen.agent} (second-best by history, score ${round3(chosen.score)}) for ${bucket}.`
    : chosen.agent !== base.agent
      ? `History reranked ${base.agent} → ${chosen.agent} for ${bucket} (score ${round3(chosen.score)} vs ${round3(first.score)}).`
      : base.reason;

  const review =
    chosen.agent === "sage" ? undefined : highComplexity ? "sage" : base.requiresReview;

  const decision: RoutingDecision = {
    agent: chosen.agent,
    reason,
    parallel: base.parallel,
    dependencies: base.dependencies,
    source: jev ? "hybrid" : "history",
    confidence: round3(confidence),
    fallback: chosen.cellN === 0 && chosen.agentN === 0,
    alternatives: scored
      .filter((candidate) => candidate.agent !== chosen.agent)
      .slice(0, 3)
      .map((candidate) => ({
        agent: candidate.agent,
        score: round3(candidate.score),
        reason: `score ${round3(candidate.score)} (cellN=${candidate.cellN}, agentN=${candidate.agentN})`,
      })),
    explain: [
      `history: ${history.terminalRows} terminal tasks; bucket=${bucket}; candidates=${scored
        .map((candidate) => candidate.agent)
        .join(", ")}`,
      ...scored.slice(0, 3).map((candidate) => {
        const marker = candidate.agent === chosen.agent ? "*" : " ";
        return `${marker} ${candidate.agent}: score=${round3(candidate.score)} pooled=${round3(
          candidate.pooled,
        )} recency=${round3(candidate.recency)} verify=${round3(candidate.verify)} duration=${round3(
          candidate.duration,
        )} confidence=${round3(candidate.confidence)} (cellN=${candidate.cellN}, agentN=${
          candidate.agentN
        })`;
      }),
    ],
  };
  if (review !== undefined) decision.requiresReview = review;
  if (explore) decision.explore = true;
  return decision;
}

/**
 * Route a task to the appropriate specialist agent (hybrid).
 *
 * Without `options.history`, behavior matches the pre-history router exactly:
 * when `options.jev` is provided and JEV is enabled, one System One request
 * classifies agent/type/risk (valid fields override the request before the
 * heuristic rules run); otherwise pure heuristic rules apply.
 *
 * With `options.history`, the heuristic/JEV candidate pool is reranked using
 * outcome history (hierarchical pooled success + recency + verify + duration +
 * JEV confidence). Epsilon-exploration (default 0.15, `options.epsilon` /
 * `options.random` injectable) can force the second-best candidate and marks
 * `explore: true`. Cold-start (no agent-level evidence) marks `fallback: true`.
 *
 * @param task - Task request from the foreman.
 * @param options - JEV config, history snapshot and injectable deps (optional).
 * @returns Routing decision; `source` indicates which signals produced it.
 */
export async function routeTask(
  task: TaskRequest,
  options: RouteOptions = {},
): Promise<RoutingDecision> {
  if (!options.jev) {
    const base = routeTaskWithRules(task);
    if (options.history) return routeWithHistory(task, base, null, options);
    return { ...base, source: "rules" };
  }

  let jev: JevRouteDecision | null = null;
  try {
    jev = await classifyRouteWithJev(
      { description: task.description, files: task.files, stack: task.stack },
      options.jev,
      options.jevDeps ?? {},
    );
  } catch {
    // classifyRouteWithJev never rejects; belt-and-suspenders for the router.
    jev = null;
  }

  const effective: TaskRequest = { ...task };
  if (jev?.type) effective.type = jev.type;
  if (jev?.risk) effective.risk = jev.risk;
  const base = routeTaskWithRules(effective);

  if (options.history) return routeWithHistory(effective, base, jev, options);

  return legacyDecision(base, jev, effective);
}

/**
 * A routing decision paired with its task ID, used for parallel conflict checks.
 */
export interface RoutedTask {
  /** Unique task identifier. */
  id: string;
  /** The routing decision for this task. */
  decision: RoutingDecision;
}

/**
 * Check if a set of tasks can run in parallel without file conflicts.
 *
 * Two tasks conflict when:
 *  - They target the same file (write race).
 *  - One task's dependency ID matches another task in the batch (ordering violation).
 *
 * Tasks with no explicit file list are assumed non-conflicting (unknown paths,
 * benefit of the doubt).
 *
 * Accepts either:
 *  - `RoutedTask[]` (preferred) — checks task ID dependencies.
 *  - `RoutingDecision[]` (legacy) — checks agent-name dependencies.
 *
 * @param tasks - Array of routed tasks or routing decisions to evaluate.
 * @returns `true` if no two tasks share a target file or have inter-batch dependencies.
 */
export function canRunParallel(tasks: RoutedTask[] | RoutingDecision[]): boolean {
  if (tasks.length === 0) return true;

  // Detect shape: RoutedTask has `id` + `decision`, RoutingDecision has `agent` + `parallel`
  const isRoutedTask = (t: unknown): t is RoutedTask =>
    typeof t === "object" && t !== null && "id" in t && "decision" in t;

  if (isRoutedTask(tasks[0])) {
    const routed = tasks as RoutedTask[];
    const allParallel = routed.every((t) => t.decision.parallel);
    if (!allParallel) return false;

    const taskIds = new Set(routed.map((t) => t.id));
    for (const task of routed) {
      for (const dep of task.decision.dependencies) {
        if (taskIds.has(dep)) return false;
      }
    }
    return true;
  }

  // Legacy path: RoutingDecision[] — dependencies are agent names
  const decisions = tasks as RoutingDecision[];
  const allParallel = decisions.every((t) => t.parallel);
  if (!allParallel) return false;

  const taskAgents = new Set(decisions.map((t) => t.agent));
  for (const task of decisions) {
    for (const dep of task.dependencies) {
      if (taskAgents.has(dep)) return false;
    }
  }
  return true;
}
