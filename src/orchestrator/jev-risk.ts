// ─── JEV Risk Traffic-Light Classification ────────────────────────────────────
/**
 * Classify a unified diff into a risk traffic light (`green|yellow|red|none`).
 *
 * Cardinal rule: the *action* lives in the deterministic catalog. `scanDiff`
 * owns pattern detection and severity; JEV is only asked to classify the light
 * for ambiguous low/medium findings. Obvious high-severity patterns short-circuit
 * to `red` without ever calling JEV.
 *
 * Decision flow (never throws):
 * 1. `scanDiff(diff)` → findings, truncated flag, scanner warnings.
 * 2. Empty/whitespace diff or no unified hunk header → `none` (deterministic).
 * 3. No findings → `green` (deterministic).
 * 4. Max severity `high` → `red` (deterministic; JEV never called).
 * 5. Max severity low/medium → ask JEV for the light. A valid answer wins
 *    (source `jev`, with an advisory warning when it differs from the
 *    deterministic expectation of `yellow`). Invalid/absent answers fall back
 *    deterministically to `yellow` (source `fallback`).
 *
 * Guarantees (inherited from `callJev`, plus local validation):
 * - Never throws. Any error/timeout/missing key/disabled config resolves to a
 *   deterministic fallback decision.
 * - `warnings` is always present (advisory only; never overrides evidence).
 * - No network access unless a TYPESAFE_API_KEY is available and `enabled` true.
 */

import { choice } from "@typesafe-ai/sdk";
import type { JevConfig } from "../config/schema.ts";
import { callJev, type JevClassifierDeps, pickChoice } from "./jev.ts";
import { type RiskFinding, type RiskSeverity, scanDiff } from "./risk-patterns.ts";

/** Traffic lights JEV (and the deterministic fallback) may return. */
export const TRAFFIC_LIGHTS = ["green", "yellow", "red", "none"] as const;
export type TrafficLight = (typeof TRAFFIC_LIGHTS)[number];

/** Maximum findings forwarded to JEV in the state payload. */
export const MAX_JEV_RISK_FINDINGS = 30;

/** Input classified by `classifyCodeRiskWithJev`. `context` is optional. */
export type JevRiskInput = { diff: string; context?: string };

/** Final decision returned to consumers (plugin tool, smoke tests). */
export type JevRiskDecision = {
  light: TrafficLight;
  source: "rules" | "jev" | "fallback";
  findings: RiskFinding[];
  /** Omitted when there are no findings. */
  maxSeverity?: RiskSeverity;
  truncated: boolean;
  warnings: string[];
};

const SEVERITY_RANK: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2 };

/** Highest severity among `findings`, or `undefined` when empty. */
function maxSeverityOf(findings: RiskFinding[]): RiskSeverity | undefined {
  let max: RiskSeverity | undefined;
  for (const finding of findings) {
    if (max === undefined || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[max]) {
      max = finding.severity;
    }
  }
  return max;
}

/**
 * A diff with no content or no unified-diff hunk header (`@@`) cannot be
 * assessed by line-level patterns, so it resolves to `none` without a JEV call.
 */
function isUnreadableDiff(diff: string): boolean {
  if (diff.trim().length === 0) return true;
  return !/^@@/m.test(diff);
}

/**
 * Builds the JEV `state` payload: the raw diff plus a capped view of the
 * findings. The cap protects the request size on pathological diffs; when it
 * applies, a warning is returned so the caller can surface it as advisory.
 *
 * `context` is included only when it is non-blank. Exported for unit testing
 * of the cap/context rules without a JEV round-trip.
 */
export function buildRiskState(
  input: JevRiskInput,
  findings: RiskFinding[],
): { state: Record<string, unknown>; warning?: string } {
  const capped = findings.slice(0, MAX_JEV_RISK_FINDINGS);
  const state: Record<string, unknown> = {
    diff: input.diff,
    findings: capped.map((finding) => ({
      id: finding.patternId,
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      snippet: finding.snippet,
      description: finding.description,
    })),
  };
  const context = input.context?.trim();
  if (context) state.context = context;

  if (findings.length > MAX_JEV_RISK_FINDINGS) {
    return { state, warning: `state truncated to ${MAX_JEV_RISK_FINDINGS} findings` };
  }
  return { state };
}

/** Builds the single `choice()` question asked for traffic-light classification. */
function buildRiskQuestions(): Record<string, unknown> {
  return {
    light: choice("What is the risk traffic light for this diff?", {
      green: "No meaningful risk found; routine change.",
      yellow: "Suspicious low/medium-severity findings worth review; not clearly dangerous.",
      red: "Clearly dangerous pattern (secrets, injection, destructive or security-sensitive code).",
      none: "Cannot assess (no usable diff or no data).",
    }),
  };
}

/**
 * Classify a diff's risk traffic light. Deterministic catalog first; JEV only
 * refines low/medium findings. Always resolves; never rejects.
 *
 * @param input - Unified diff plus optional context sent as state.
 * @param cfg - JEV config (`enabled`, `model`, `timeoutMs`).
 * @param deps - Injectable apiKey/clientFactory/log (tests).
 * @returns A full decision: light, source, findings, maxSeverity, warnings.
 */
export async function classifyCodeRiskWithJev(
  input: JevRiskInput,
  cfg: JevConfig,
  deps: JevClassifierDeps = {},
): Promise<JevRiskDecision> {
  const { findings, truncated, warnings: scannerWarnings } = scanDiff(input.diff);
  const warnings = [...scannerWarnings];

  // 2. Unreadable diff (empty/whitespace or no hunks) → none, no JEV.
  if (isUnreadableDiff(input.diff)) {
    return { light: "none", source: "rules", findings, truncated, warnings };
  }

  // 3. Nothing flagged → green, no JEV.
  if (findings.length === 0) {
    return { light: "green", source: "rules", findings, truncated, warnings };
  }

  const maxSeverity = maxSeverityOf(findings);

  // 4. An obvious high-severity pattern is a deterministic red — never soften.
  if (maxSeverity === "high") {
    return { light: "red", source: "rules", findings, maxSeverity, truncated, warnings };
  }

  // 5. Ambiguous low/medium findings → JEV classifies the light.
  const built = buildRiskState(input, findings);
  if (built.warning) warnings.push(built.warning);

  const answers = await callJev(built.state, buildRiskQuestions(), cfg, deps);
  const jevLight = answers ? pickChoice(answers.light, TRAFFIC_LIGHTS) : undefined;

  if (jevLight !== undefined) {
    // Design expectation: low/medium falls back to "yellow". Any other valid
    // answer is accepted (JEV classifies) but flagged as advisory.
    if (jevLight !== "yellow") {
      warnings.push(
        `JEV classified "${jevLight}" but the deterministic fallback expected "yellow" for ${maxSeverity}-severity findings`,
      );
    }
    return {
      light: jevLight,
      source: "jev",
      findings,
      ...(maxSeverity !== undefined ? { maxSeverity } : {}),
      truncated,
      warnings,
    };
  }

  warnings.push(
    answers
      ? "JEV returned an invalid answer — deterministic fallback"
      : "JEV unavailable — deterministic fallback",
  );
  return {
    light: "yellow",
    source: "fallback",
    findings,
    ...(maxSeverity !== undefined ? { maxSeverity } : {}),
    truncated,
    warnings,
  };
}
