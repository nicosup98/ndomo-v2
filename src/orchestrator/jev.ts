// ─── JEV (TypeSafe AI System One) Task Classification ─────────────────────────
/**
 * Hybrid routing support: classify a task with JEV (one `systemOne` request,
 * three parallel choice questions) and fall back to the heuristic router
 * whenever JEV is unavailable, disabled, times out, or answers with values
 * outside the accepted enums.
 *
 * Guarantees:
 * - Never throws. Any error (config, network, timeout, malformed response)
 *   resolves to `null` or to a partial decision with invalid fields dropped.
 * - No network access unless a TYPESAFE_API_KEY is available and `enabled` is true.
 * - The client is injectable (`deps.clientFactory`) so tests run fully offline.
 *
 * The API key is read from the TYPESAFE_API_KEY environment variable only.
 */

import { TypeSafeClient, choice } from "@typesafe-ai/sdk";
import type {
  ChoiceQuestion,
  EntryType,
  RequestOptions,
  SystemOneRequest,
} from "@typesafe-ai/sdk";
import type { JevConfig } from "../config/schema.ts";
import type { TaskRequest } from "./scheduler.ts";

/** Agents JEV is allowed to select. Delegation beyond this set is a foreman concern. */
export const JEV_AGENTS = ["ranger", "craftsman", "warden"] as const;
export type JevAgent = (typeof JEV_AGENTS)[number];

/** Task types JEV is allowed to select (mirrors the heuristic router's union). */
export const JEV_TYPES = [
  "implement",
  "explore",
  "research",
  "design",
  "debug",
  "audit",
  "document",
  "debate",
] as const satisfies readonly TaskRequest["type"][];
export type JevType = (typeof JEV_TYPES)[number];

/** Risk levels JEV is allowed to select. */
export const JEV_RISKS = ["low", "medium", "high"] as const;
export type JevRisk = (typeof JEV_RISKS)[number];

/**
 * Partial classification. Invalid or missing answers are omitted per field;
 * `null` is returned when every field is missing or invalid.
 */
export type JevDecision = {
  agent?: JevAgent;
  type?: JevType;
  risk?: JevRisk;
};

/** Minimal task shape sent to JEV as state. */
export type JevTaskInput = {
  description: string;
  files?: string[] | undefined;
  stack?: string | undefined;
};

/** Request shape accepted by the injectable client. */
export type JevSystemOneRequest = {
  state: unknown;
  questions: Record<string, unknown>;
  model?: string;
};

/** Per-call options accepted by the injectable client. */
export type JevRequestOptions = {
  signal?: AbortSignal;
  timeout?: number;
};

/** Minimal client contract: structurally satisfied by the real SDK client wrapper. */
export interface JevClientLike {
  systemOne(
    request: JevSystemOneRequest,
    options?: JevRequestOptions,
  ): Promise<{ answers?: Record<string, unknown> }>;
}

/** Factory used to build a client. Override in tests to avoid network access. */
export type JevClientFactory = (apiKey: string, cfg: JevConfig) => JevClientLike;

/** Injectable dependencies. */
export type JevClassifierDeps = {
  /** Overrides TYPESAFE_API_KEY (tests use "" to simulate a missing key). */
  apiKey?: string | undefined;
  /** Overrides the real SDK client factory. */
  clientFactory?: JevClientFactory | undefined;
  /** Overrides the debug logger (defaults to console.debug). */
  log?: ((message: string) => void) | undefined;
};

let warnedMissingKey = false;

function logOnce(log: (message: string) => void): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  log("[jev] TYPESAFE_API_KEY not set — JEV disabled, using heuristic routing.");
}

/** Reset the "warned once" flag. Exported for tests only. */
export function resetJevWarningState(): void {
  warnedMissingKey = false;
}

function createDefaultClient(apiKey: string, cfg: JevConfig): JevClientLike {
  const client = new TypeSafeClient({ apiKey, defaultModel: cfg.model });
  return {
    async systemOne(request, options) {
      const response = await client.systemOne(
        request as unknown as SystemOneRequest<Record<string, ChoiceQuestion>>,
        options as RequestOptions,
      );
      return { answers: response.answers as Record<string, unknown> };
    },
  };
}

function buildState(task: JevTaskInput): EntryType {
  const state: { description: string; files?: string[]; stack?: string } = {
    description: task.description,
  };
  if (task.files && task.files.length > 0) {
    state.files = task.files;
  }
  if (task.stack && task.stack !== "unknown") {
    state.stack = task.stack;
  }
  return state;
}

function buildQuestions(): Record<string, unknown> {
  return {
    agent: choice("Which single agent should execute this task?", {
      ranger:
        "Exploration and reconnaissance only: read code, map architecture, gather context. Does not write code.",
      craftsman:
        "Implementation: writes and edits code, fixes bugs, adds tests, refactors within a bounded scope.",
      warden:
        "Operations: infrastructure, CI/CD, deploys, server maintenance, environment configuration.",
    }),
    type: choice("What type of work is this task?", {
      implement: "Building, changing, or fixing software.",
      explore: "Reading and mapping existing code without modifications.",
      research: "Investigating APIs, docs, or external knowledge.",
      design: "Designing UI, UX, or visual output.",
      debug: "Diagnosing a failure or unexpected behavior.",
      audit: "Reviewing code quality or security.",
      document: "Writing or updating documentation.",
      debate: "Weighing options or reaching consensus.",
    }),
    risk: choice("What is the risk level of this task?", {
      low: "Local, easily reversible change with no cross-cutting impact.",
      medium: "Touches shared code or behavior across a bounded area.",
      high: "Impacts production, data integrity, security, or many call sites.",
    }),
  };
}

/** Extracts a valid choice label from an answer, or `undefined` when invalid. */
function pickChoice<T extends string>(answer: unknown, allowed: readonly T[]): T | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const candidate = (answer as { choice?: unknown }).choice;
  if (typeof candidate !== "string") return undefined;
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T) : undefined;
}

/** Validates raw answers and keeps only the fields within the accepted enums. */
function mergeAnswers(answers: Record<string, unknown> | undefined): JevDecision | null {
  if (!answers) return null;
  const decision: JevDecision = {};
  const agent = pickChoice(answers.agent, JEV_AGENTS);
  const type = pickChoice(answers.type, JEV_TYPES);
  const risk = pickChoice(answers.risk, JEV_RISKS);
  if (agent) decision.agent = agent;
  if (type) decision.type = type;
  if (risk) decision.risk = risk;
  return decision.agent || decision.type || decision.risk ? decision : null;
}

/**
 * Classify a task with JEV. Always resolves; never rejects.
 *
 * @param task - Task description plus optional files/stack sent as state.
 * @param cfg - JEV config (`enabled`, `model`, `timeoutMs`).
 * @param deps - Injectable apiKey/clientFactory/log (tests).
 * @returns Validated partial decision, or `null` when JEV cannot answer.
 */
export async function classifyTaskWithJev(
  task: JevTaskInput,
  cfg: JevConfig,
  deps: JevClassifierDeps = {},
): Promise<JevDecision | null> {
  if (!cfg.enabled) return null;

  const apiKey = (deps.apiKey ?? process.env.TYPESAFE_API_KEY ?? "").trim();
  if (apiKey.length === 0) {
    logOnce(deps.log ?? ((message) => console.debug(message)));
    return null;
  }

  const log = deps.log ?? ((message) => console.debug(message));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = (deps.clientFactory ?? createDefaultClient)(apiKey, cfg);
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, cfg.timeoutMs);
    });
    const request: JevSystemOneRequest = {
      state: buildState(task),
      questions: buildQuestions(),
      model: cfg.model,
    };
    const response = await Promise.race([
      client.systemOne(request, { signal: controller.signal, timeout: cfg.timeoutMs }),
      timeoutPromise,
    ]);
    if (response === null) {
      log("[jev] request timed out — falling back to heuristic routing.");
      return null;
    }
    return mergeAnswers(response.answers);
  } catch {
    log("[jev] classification failed — falling back to heuristic routing.");
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
