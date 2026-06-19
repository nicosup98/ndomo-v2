/**
 * Result reconciliation for parallel agent tasks.
 * Merges outputs from multiple specialist agents into a unified report.
 */

/** Result from a single completed task. */
export interface TaskResult {
  /** Task ID from the dispatcher. */
  taskId: string;
  /** Agent that produced this result. */
  agent: string;
  /** Agent's output text. */
  output: string;
  /** Files the agent modified or created. */
  filesModified: string[];
  /** Whether the task succeeded. */
  success: boolean;
}

/** Unified report after reconciling multiple task results. */
export interface ReconciliationReport {
  /** Merged summary of all agent outputs. */
  mergedSummary: string;
  /** File paths where two or more agents wrote (potential conflicts). */
  conflicts: string[];
  /** Deduplicated list of all files touched across all tasks. */
  allFilesModified: string[];
  /** Actionable next steps based on the results. */
  recommendations: string[];
}

/**
 * Reconcile results from multiple parallel agent tasks.
 *
 * Detects file conflicts (two agents modified the same file),
 * merges output summaries, and generates recommendations.
 *
 * @param results - Array of task results to reconcile.
 * @returns A unified reconciliation report.
 */
export function reconcileResults(results: TaskResult[]): ReconciliationReport {
  const conflicts: string[] = [];
  const allFilesModified: string[] = [];
  const recommendations: string[] = [];
  const summaryParts: string[] = [];

  // Track which agents modified each file
  const fileAgents = new Map<string, Set<string>>();

  for (const result of results) {
    // Build summary
    const status = result.success ? "ok" : "FAILED";
    summaryParts.push(`[${result.agent}:${status}] ${truncate(result.output, 200)}`);

    // Track file ownership
    for (const file of result.filesModified) {
      allFilesModified.push(file);

      const agents = fileAgents.get(file);
      if (agents) {
        agents.add(result.agent);
      } else {
        fileAgents.set(file, new Set([result.agent]));
      }
    }

    // Flag failures as recommendations
    if (!result.success) {
      recommendations.push(
        `Task ${result.taskId} (${result.agent}) failed: ${truncate(result.output, 100)}`,
      );
    }
  }

  // Detect conflicts: files modified by multiple agents
  for (const [file, agents] of fileAgents.entries()) {
    if (agents.size > 1) {
      const agentList = Array.from(agents).join(", ");
      conflicts.push(`CONFLICT: ${file} modified by ${agentList}`);
      recommendations.push(
        `Review merge conflict in ${file} — touched by: ${agentList}. Manual resolution may be needed.`,
      );
    }
  }

  // Deduplicate file list
  const uniqueFiles = [...new Set(allFilesModified)];

  // General recommendations
  if (conflicts.length === 0 && results.length > 1) {
    recommendations.push("No file conflicts detected. Safe to merge.");
  }

  if (results.every((r) => r.success)) {
    recommendations.push("All tasks succeeded. Run tests to verify integration.");
  }

  const failedCount = results.filter((r) => !r.success).length;
  if (failedCount > 0) {
    recommendations.push(
      `${failedCount}/${results.length} tasks failed. Review failures before proceeding.`,
    );
  }

  return {
    mergedSummary: summaryParts.join("\n"),
    conflicts,
    allFilesModified: uniqueFiles,
    recommendations,
  };
}

/**
 * Truncate text to a maximum length, appending "…" if truncated.
 *
 * @param text - Text to truncate.
 * @param maxLength - Maximum character count.
 * @returns Truncated string.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}
