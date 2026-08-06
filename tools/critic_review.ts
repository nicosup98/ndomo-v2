/**
 * ndomo — critic_review custom tool (v17 / T2).
 *
 * Validates and returns a binary, structured review report. This tool does
 * not mutate task state: APPROVED reports must still be submitted through
 * task_verify by the inspector, preserving the T1 execution-gate authority.
 */

import { tool } from "@opencode-ai/plugin";
import { buildCriticReview, toTaskVerification } from "ndomo/db";

export default tool({
  description:
    "Return a binary APPROVED/REJECTED code-review report from a diff. The result includes the T1 task_verify payload; it never bypasses inspector authority.",
  args: {
    diff: tool.schema.string(),
    verdict: tool.schema.enum(["APPROVED", "REJECTED"]),
    critical: tool.schema.unknown().optional(),
    optimizations: tool.schema.unknown().optional(),
    compliance: tool.schema.unknown().optional(),
    actionRequired: tool.schema.string().optional(),
    scores: tool.schema.unknown().optional(),
  },
  execute: async (args, ctx) => {
    const review = buildCriticReview({
      diff: args.diff,
      verdict: args.verdict,
      reviewedBy: ctx.agent ?? "critic",
      critical: args.critical,
      optimizations: args.optimizations,
      compliance: args.compliance,
      actionRequired: args.actionRequired,
      scores: args.scores,
    });
    return JSON.stringify(
      {
        ...review,
        executionGate: toTaskVerification(review),
      },
      null,
      2,
    );
  },
});
