/**
 * Agent routing logic for the ndomo orchestrator.
 * Pure functions that determine which specialist agent handles a task.
 */

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
}

/** Incoming task request from the foreman. */
export interface TaskRequest {
  /** Natural language description of what to do. */
  description: string;
  /** Detected or declared tech stack. */
  stack?: "go" | "vue" | "js" | "python" | "zig" | "generic" | "unknown";
  /** Category of work. */
  type:
    | "implement"
    | "explore"
    | "research"
    | "design"
    | "debug"
    | "audit"
    | "document"
    | "debate";
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
 * Route a task to the appropriate specialist agent.
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
export function routeTask(task: TaskRequest): RoutingDecision {
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
        dependencies: ["sage"],
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

/**
 * Check if a set of tasks can run in parallel without file conflicts.
 *
 * Two tasks conflict when they target the same file — parallel execution
 * would cause write races. Tasks with no explicit file list are assumed
 * non-conflicting (they operate on unknown paths, so we give them the
 * benefit of the doubt).
 *
 * @param tasks - Array of routing decisions to evaluate.
 * @returns `true` if no two tasks share a target file.
 */
export function canRunParallel(tasks: RoutingDecision[]): boolean {
  // If any task is non-parallel, the batch can't be fully parallel
  const allParallel = tasks.every((t) => t.parallel);
  if (!allParallel) return false;

  // Check dependency conflicts: if task A depends on task B's output,
  // they can't run in parallel
  const taskAgents = new Set(tasks.map((t) => t.agent));
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      // If the dependency is another task in this batch, they can't be parallel
      if (taskAgents.has(dep)) return false;
    }
  }

  return true;
}
