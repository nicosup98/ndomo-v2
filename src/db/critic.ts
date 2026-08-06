/**
 * Critic review protocol (T2).
 *
 * This module deliberately does not make a QA decision. The critic agent
 * supplies the binary verdict and this module validates/normalizes its
 * structured report. Execution-gate writes remain owned by `task_verify` and
 * the inspector authority from T1.
 */

export const CRITIC_VERDICTS = ["APPROVED", "REJECTED"] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

export interface CriticScores {
  security: number | null;
  performance: number | null;
  idiomaticity: number | null;
}

export interface CriticReview {
  protocol: "ndomo.critic.v1";
  verdict: CriticVerdict;
  reviewedBy: string;
  diff: {
    provided: true;
    lines: number;
    bytes: number;
  };
  critical: string[];
  optimizations: string[];
  compliance: string[];
  actionRequired: string | null;
  scores: CriticScores;
  reviewedAt: number;
}

export interface CriticReviewInput {
  diff: string;
  verdict: CriticVerdict;
  reviewedBy?: string;
  critical?: unknown;
  optimizations?: unknown;
  compliance?: unknown;
  actionRequired?: unknown;
  scores?: unknown;
}

function asList(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((entry) => entry.replace(/^[-*]\s*/, "").trim())
      .filter((entry) => entry.length > 0);
  }
  return [String(value).trim()].filter((entry) => entry.length > 0);
}

function asScore(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new Error(`ndomo: critic score '${field}' must be a number from 0 to 10`);
  }
  return score;
}

function normalizeScores(value: unknown): CriticScores {
  if (value === undefined || value === null) {
    return { security: null, performance: null, idiomaticity: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ndomo: critic scores must be an object");
  }
  const scores = value as Record<string, unknown>;
  return {
    security: asScore(scores.security, "security"),
    performance: asScore(scores.performance, "performance"),
    idiomaticity: asScore(scores.idiomaticity, "idiomaticity"),
  };
}

/** Validate and normalize one binary critic report. */
export function buildCriticReview(input: CriticReviewInput): CriticReview {
  if (!CRITIC_VERDICTS.includes(input.verdict)) {
    throw new Error(
      `ndomo: invalid critic verdict '${String(input.verdict)}' — expected APPROVED or REJECTED`,
    );
  }
  if (typeof input.diff !== "string" || input.diff.trim().length === 0) {
    throw new Error("ndomo: critic review requires a non-empty diff");
  }

  const critical = asList(input.critical);
  const actionRequired =
    input.actionRequired === undefined || input.actionRequired === null
      ? null
      : String(input.actionRequired).trim() || null;

  return {
    protocol: "ndomo.critic.v1",
    verdict: input.verdict,
    reviewedBy: input.reviewedBy?.trim() || "critic",
    diff: {
      provided: true,
      lines: input.diff.split(/\r?\n/).length,
      bytes: Buffer.byteLength(input.diff, "utf8"),
    },
    critical,
    optimizations: asList(input.optimizations),
    compliance: asList(input.compliance),
    actionRequired,
    scores: normalizeScores(input.scores),
    reviewedAt: Date.now(),
  };
}

/**
 * Convert a critic report to the T1 execution-gate payload. The caller must
 * still submit an APPROVED report through `task_verify` as `inspector`; a
 * critic report never bypasses that authority boundary by itself.
 */
export function toTaskVerification(review: CriticReview): {
  verdict: "passed" | "failed";
  result: Record<string, unknown>;
  reason?: string;
} {
  if (review.verdict === "APPROVED") {
    return { verdict: "passed", result: review as unknown as Record<string, unknown> };
  }
  const reason =
    review.critical.join("; ") || review.actionRequired || "Critic rejected the review";
  return {
    verdict: "failed",
    result: review as unknown as Record<string, unknown>,
    reason,
  };
}
