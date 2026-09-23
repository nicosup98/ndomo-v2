// ─── JEV Intent / Flow Classification ─────────────────────────────────────────
/**
 * Intent & flow classification built on the shared `callJev` primitive.
 *
 * Two parallel choice questions are asked: the user's `intent` (what they want)
 * and the `flow` that should handle the prompt (how the system should respond).
 *
 * Guarantees (inherited from `callJev`, plus local validation):
 * - Never throws. Any error/timeout/missing key resolves to `null`.
 * - Invalid answers are dropped per field; only fields inside the accepted enums
 *   are kept. When *no* field is valid, `null` is returned.
 * - `warnings` is always present (empty array when there is no mismatch).
 *   Mismatch warnings are ADVISORY only: they never override or drop a valid field.
 * - No network access unless a TYPESAFE_API_KEY is available and `enabled` is true.
 */

import { choice } from "@typesafe-ai/sdk";
import type { JevConfig } from "../config/schema.ts";
import { callJev, type JevClassifierDeps, pickChoice } from "./jev.ts";

/** Intents JEV is allowed to select for an incoming prompt. */
export const JEV_INTENTS = ["bugfix", "feature", "refactor", "question", "other", "none"] as const;
export type JevIntent = (typeof JEV_INTENTS)[number];

/** Workflows JEV is allowed to select for an incoming prompt. */
export const JEV_FLOWS = ["answer", "adhoc", "plan", "none"] as const;
export type JevFlow = (typeof JEV_FLOWS)[number];

/** Input classified by `classifyIntentWithJev`. `context` is optional. */
export type JevIntentInput = { prompt: string; context?: string };

/**
 * Partial intent/flow classification. Invalid or missing fields are omitted;
 * `null` is returned only when every field is missing or invalid.
 * `warnings` is always present and advisory.
 */
export type JevIntentDecision = {
  intent?: JevIntent;
  flow?: JevFlow;
  warnings: string[];
};

/** Intents that imply implementing/altering code (used for mismatch advice). */
const IMPLEMENTABLE_INTENTS: readonly JevIntent[] = ["bugfix", "feature", "refactor"];

/** Builds the two `choice()` questions asked for intent/flow classification. */
function buildIntentQuestions(): Record<string, unknown> {
  return {
    intent: choice("What is the user's intent in this prompt?", {
      bugfix: "Fixing broken behavior in existing code.",
      feature: "Adding new capability or functionality.",
      refactor: "Restructuring existing code without changing behavior.",
      question: "The user asks for information, explanation, or advice; no code change requested.",
      other: "None of the specific intents fit, but it is decidable.",
      none: "Cannot determine the intent.",
    }),
    flow: choice("What workflow should handle this prompt?", {
      answer: "Reply directly with an explanation; no code work.",
      adhoc: "Small bounded code change executed directly without a plan.",
      plan: "Work large enough to need a plan and task breakdown.",
      none: "Cannot determine the flow.",
    }),
  };
}

/**
 * Classify an incoming prompt by intent and flow with JEV.
 * Always resolves; never rejects.
 *
 * @param input - Prompt plus optional context sent as state.
 * @param cfg - JEV config (`enabled`, `model`, `timeoutMs`).
 * @param deps - Injectable apiKey/clientFactory/log (tests).
 * @returns Validated partial decision (with advisory `warnings`), or `null`.
 */
export async function classifyIntentWithJev(
  input: JevIntentInput,
  cfg: JevConfig,
  deps: JevClassifierDeps = {},
): Promise<JevIntentDecision | null> {
  const state: { prompt: string; context?: string } = { prompt: input.prompt };
  const context = input.context?.trim();
  if (context) state.context = context;

  const answers = await callJev(state, buildIntentQuestions(), cfg, deps);
  if (!answers) return null;

  const intent = pickChoice(answers.intent, JEV_INTENTS);
  const flow = pickChoice(answers.flow, JEV_FLOWS);
  if (!intent && !flow) return null;

  const decision: JevIntentDecision = { warnings: [] };
  if (intent) decision.intent = intent;
  if (flow) decision.flow = flow;

  // Advisory mismatch hints: a valid field is never dropped or overridden.
  if (intent === "question" && flow !== undefined && flow !== "answer" && flow !== "none") {
    decision.warnings.push(
      `flow "${flow}" usually pairs with implementable intents, not "question"`,
    );
  }
  if (intent !== undefined && IMPLEMENTABLE_INTENTS.includes(intent) && flow === "answer") {
    decision.warnings.push(`flow "answer" usually pairs with intent "question", not "${intent}"`);
  }

  return decision;
}
