/**
 * ndomo audit — deterministic score (1–100).
 *
 * Formula (documented, no randomness, no clock):
 *
 * ```
 * score = max(1, 100 − 10·ERROR − 4·WARN − 1·INFO)
 * ```
 *
 * - Each `ERROR` costs **10** (security/config breakage).
 * - Each `WARN` costs **4** (drift that will surprise a user).
 * - Each `INFO` costs **1** (informational staleness).
 * - Floor of **1** — a fully broken repo still scores 1, never 0, so callers
 *   can treat `score < 100` as "something to look at" and `score ≤ 90` as
 *   "act now" without a zero-value edge case.
 *
 * Weights live in `SEVERITY_WEIGHT` (types.ts) so the CLI and tests import the
 * same constants the scorer uses.
 */

import { type Finding, SEVERITY_WEIGHT, type Severity } from "./types.ts";

/** Minimum attainable score. */
export const SCORE_FLOOR = 1;

/** Starting score before penalties. */
export const SCORE_CEILING = 100;

/**
 * Compute the audit score from findings.
 *
 * Deterministic and order-independent (pure summation of severities).
 */
export function computeScore(findings: readonly Finding[]): number {
  const counts: Record<Severity, number> = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const finding of findings) counts[finding.severity] += 1;

  const penalty =
    counts.ERROR * SEVERITY_WEIGHT.ERROR +
    counts.WARN * SEVERITY_WEIGHT.WARN +
    counts.INFO * SEVERITY_WEIGHT.INFO;

  return Math.max(SCORE_FLOOR, SCORE_CEILING - penalty);
}

/** Per-severity tally used by the report summary. */
export function summarize(findings: readonly Finding[]): {
  error: number;
  warn: number;
  info: number;
  total: number;
} {
  let error = 0;
  let warn = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === "ERROR") error += 1;
    else if (finding.severity === "WARN") warn += 1;
    else info += 1;
  }
  return { error, warn, info, total: findings.length };
}
