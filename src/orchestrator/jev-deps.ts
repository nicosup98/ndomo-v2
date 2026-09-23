// ─── JEV Task-Dependency Analysis ─────────────────────────────────────────────
/**
 * Analyze implicit dependencies between the tasks of a plan and derive a
 * deterministic execution DAG with parallelizable waves.
 *
 * Cardinal rule: the *code* builds the DAG. JEV is only asked to choose a
 * direction per candidate pair (`a_first|b_first|independent|none`); it never
 * decides topology, cycles or waves. Candidate pairs are pre-filtered by
 * deterministic hints (shared files, ordering keywords); everything else is
 * resolved by rules.
 *
 * Guarantees (inherited from `callJev`, plus local validation):
 * - Never throws. Any error/timeout/missing key/disabled config resolves to a
 *   deterministic rules-only decision.
 * - No JEV call at all when there are no candidate pairs.
 * - Invalid/absent answers per pair fall back to the deterministic rules
 *   suggestion for that pair (source `rules`) with an advisory warning.
 * - Cycles are broken deterministically (highest pair index first) and
 *   reported in `dropped` with reason `cycle`.
 * - No network access unless a TYPESAFE_API_KEY is available and `enabled` true.
 */

import { choice } from "@typesafe-ai/sdk";
import type { JevConfig } from "../config/schema.ts";
import { callJev, type JevClassifierDeps, pickChoice } from "./jev.ts";

/** Directional outcomes JEV (and the deterministic rules) may return per pair. */
export const DEP_CHOICES = ["a_first", "b_first", "independent", "none"] as const;
export type DepChoice = (typeof DEP_CHOICES)[number];

/** Maximum tasks considered (cap) and the resulting maximum pair count C(8,2). */
export const MAX_DEPS_TASKS = 8;
export const MAX_DEP_PAIRS = 28; // C(8,2)

/** Ordering keywords scanned (word-boundary, case-insensitive) in descriptions. */
export const DEP_KEYWORDS = [
  "after",
  "depends on",
  "depends",
  "requires",
  "once",
  "then",
  "builds on",
] as const;

/** Maximum description length forwarded to JEV per task. */
const MAX_DESCRIPTION_CHARS = 300;

/** Input task considered by `analyzeTaskDependencies`. */
export type TaskDepInput = {
  id: string;
  description: string;
  files?: string[];
  orderIndex?: number;
};

/** A resolved pair with its deterministic hints and final suggestion. */
export type DepPair = {
  a: string; // id tarea A
  b: string; // id tarea B
  hints: string[]; // ej. ["shared files: src/x.ts", "keyword on B: after"]
  overlapFiles: string[];
  suggested: DepChoice; // decisión final (jev válida o fallback rules)
  source: "rules" | "jev"; // origen de `suggested`
};

/** Directed edge: `from` finishes before `to` (`to` depends on `from`). */
export type DepEdge = { from: string; to: string };

/** Final decision returned to consumers (plugin tool, smoke tests). */
export type JevDepsDecision = {
  source: "rules" | "jev" | "hybrid";
  pairs: DepPair[];
  edges: DepEdge[]; // SOLO de choices direccionales (a_first/b_first), sin ciclos
  waves: string[][]; // waves topológicas de ids
  dropped: Array<{ a: string; b: string; reason: "none" | "invalid" | "cycle" }>;
  suggestions: Record<string, string[]>; // taskId dependiente -> ids de deps sugeridas
  truncated: boolean;
  warnings: string[];
};

/** Internal edge carrying the originating pair index (for deterministic drops). */
type InternalEdge = { from: string; to: string; pairIndex: number };

/** Per-pair deterministic metadata. `index` is the index within the pair array. */
type PairMeta = {
  index: number;
  key: string;
  a: TaskDepInput;
  b: TaskDepInput;
  hints: string[];
  overlapFiles: string[];
  hasKeywordA: boolean;
  hasKeywordB: boolean;
};

/** Mutable per-pair resolution (rules first, overridden by a valid JEV answer). */
type PairResolution = {
  meta: PairMeta;
  choice: DepChoice;
  source: "rules" | "jev";
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Ordering keywords present in `text` (word-boundary, case-insensitive). */
function keywordHits(text: string): string[] {
  const hits: string[] = [];
  for (const keyword of DEP_KEYWORDS) {
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
    if (re.test(text)) hits.push(keyword);
  }
  return hits;
}

/** Exact intersection of two file lists (A's order preserved, de-duplicated). */
function intersectFiles(a: string[] | undefined, b: string[] | undefined): string[] {
  if (!a || !b || a.length === 0 || b.length === 0) return [];
  const inB = new Set(b);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const file of a) {
    if (inB.has(file) && !seen.has(file)) {
      seen.add(file);
      result.push(file);
    }
  }
  return result;
}

/**
 * Cap the task list to `MAX_DEPS_TASKS`, ordered by `orderIndex` ascending
 * (`undefined` last) with a stable tiebreak on input order.
 */
function capTasks(tasks: TaskDepInput[]): {
  tasks: TaskDepInput[];
  truncated: boolean;
  warning?: string;
} {
  if (tasks.length <= MAX_DEPS_TASKS) {
    return { tasks: [...tasks], truncated: false };
  }
  const indexed = tasks.map((task, index) => ({ task, index }));
  indexed.sort((x, y) => {
    const ox = x.task.orderIndex ?? Number.POSITIVE_INFINITY;
    const oy = y.task.orderIndex ?? Number.POSITIVE_INFINITY;
    if (ox !== oy) return ox - oy;
    return x.index - y.index;
  });
  return {
    tasks: indexed.slice(0, MAX_DEPS_TASKS).map((entry) => entry.task),
    truncated: true,
    warning: `analyzed first ${MAX_DEPS_TASKS} of ${tasks.length} tasks`,
  };
}

/** Build every unordered pair (i<j, deterministic order) with its hints. */
function buildPairs(tasks: TaskDepInput[]): PairMeta[] {
  const metas: PairMeta[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i];
      const b = tasks[j];
      if (a === undefined || b === undefined) continue;
      const overlapFiles = intersectFiles(a.files, b.files);
      const hitsA = keywordHits(a.description);
      const hitsB = keywordHits(b.description);
      const hints: string[] = [
        ...overlapFiles.map((file) => `shared files: ${file}`),
        ...hitsA.map((keyword) => `keyword on A: ${keyword}`),
        ...hitsB.map((keyword) => `keyword on B: ${keyword}`),
      ];
      metas.push({
        index: metas.length,
        key: `pair_${metas.length}`,
        a,
        b,
        hints,
        overlapFiles,
        hasKeywordA: hitsA.length > 0,
        hasKeywordB: hitsB.length > 0,
      });
    }
  }
  return metas;
}

/**
 * Deterministic rules suggestion for a pair.
 * - Keyword in exactly one task → that task is the dependent (posterior).
 *   Keyword in A → `b_first`; keyword in B → `a_first`.
 * - Keyword in both or neither → `none` when files overlap, else `independent`.
 */
function ruleChoice(hasKeywordA: boolean, hasKeywordB: boolean, overlapCount: number): DepChoice {
  if (hasKeywordA && !hasKeywordB) return "b_first";
  if (hasKeywordB && !hasKeywordA) return "a_first";
  return overlapCount > 0 ? "none" : "independent";
}

/** JEV `state` payload: all capped tasks plus every pair (candidates and not). */
function buildState(tasks: TaskDepInput[], metas: PairMeta[]): Record<string, unknown> {
  return {
    tasks: tasks.map((task) => ({
      id: task.id,
      description: task.description.slice(0, MAX_DESCRIPTION_CHARS),
      files: task.files ?? [],
      ...(task.orderIndex !== undefined ? { orderIndex: task.orderIndex } : {}),
    })),
    pairs: metas.map((meta) => ({
      key: meta.key,
      a: meta.a.id,
      b: meta.b.id,
      hints: meta.hints,
      overlapFiles: meta.overlapFiles,
    })),
  };
}

/** Build one `choice()` question per candidate pair (keyed `pair_<index>`). */
function buildQuestions(metas: PairMeta[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const meta of metas) {
    if (meta.hints.length === 0) continue;
    questions[meta.key] = choice(
      `Which task must come first: A "${meta.a.id}" or B "${meta.b.id}"?`,
      {
        a_first: "Task A must be completed before B",
        b_first: "Task B must be completed before A",
        independent: "No ordering needed",
        none: "Cannot determine",
      },
    );
  }
  return questions;
}

/** Deterministic comparator: `orderIndex` asc (undefined last), then input order. */
function makeRanker(tasks: TaskDepInput[]): (id: string) => number {
  const rank = new Map<string, number>();
  tasks.forEach((task, index) => {
    rank.set(task.id, index);
  });
  const orderIndex = new Map<string, number>();
  tasks.forEach((task) => {
    orderIndex.set(task.id, task.orderIndex ?? Number.POSITIVE_INFINITY);
  });
  return (id: string) => {
    const oi = orderIndex.get(id) ?? Number.POSITIVE_INFINITY;
    const ii = rank.get(id) ?? Number.POSITIVE_INFINITY;
    // Encode both keys into a single sortable number: orderIndex dominates.
    // A large multiplier keeps input order as the tiebreak for realistic sizes.
    return oi * 1_000_000 + ii;
  };
}

/** Kahn's algorithm: nodes with a non-zero remaining in-degree (cycle-reachable). */
function stuckNodes(order: string[], edges: InternalEdge[]): Set<string> {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of order) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const processed = new Set<string>();
  const queue: string[] = [];
  for (const id of order) {
    if ((inDegree.get(id) ?? 0) === 0) {
      processed.add(id);
      queue.push(id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    for (const to of adjacency.get(id) ?? []) {
      const next = (inDegree.get(to) ?? 0) - 1;
      inDegree.set(to, next);
      if (next === 0 && !processed.has(to)) {
        processed.add(to);
        queue.push(to);
      }
    }
  }
  const stuck = new Set<string>();
  for (const id of order) {
    if (!processed.has(id)) stuck.add(id);
  }
  return stuck;
}

/** Topological waves; wave 0 = no incoming edges, tiebreak by rank. */
function computeWaves(
  order: string[],
  edges: InternalEdge[],
  rank: (id: string) => number,
): string[][] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const id of order) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const remaining = new Set(order);
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => (inDegree.get(id) ?? 0) === 0);
    if (ready.length === 0) {
      // Safety net: a cycle survived (should not happen after cycle removal).
      const rest = [...remaining].sort((x, y) => rank(x) - rank(y));
      waves.push(rest);
      break;
    }
    ready.sort((x, y) => rank(x) - rank(y));
    waves.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const to of adjacency.get(id) ?? []) {
        inDegree.set(to, (inDegree.get(to) ?? 0) - 1);
      }
    }
  }
  return waves;
}

/** Degraded decision used by the global catch-all. */
function degradedDecision(
  tasks: TaskDepInput[],
  truncated: boolean,
  warnings: string[],
): JevDepsDecision {
  const ids = tasks.map((task) => task.id);
  return {
    source: "rules",
    pairs: [],
    edges: [],
    waves: ids.length > 0 ? [ids] : [],
    dropped: [],
    suggestions: {},
    truncated,
    warnings,
  };
}

/**
 * Analyze implicit dependencies across plan tasks. Always resolves; never rejects.
 *
 * @param tasks - Plan tasks (capped to `MAX_DEPS_TASKS`, ordered by `orderIndex`).
 * @param cfg - JEV config (`enabled`, `model`, `timeoutMs`).
 * @param deps - Injectable apiKey/clientFactory/log (tests).
 * @returns A full decision: pairs, DAG edges, topological waves, drops, warnings.
 */
export async function analyzeTaskDependencies(
  tasks: TaskDepInput[],
  cfg: JevConfig,
  deps: JevClassifierDeps = {},
): Promise<JevDepsDecision> {
  const warnings: string[] = [];
  let truncated = false;
  let capped: TaskDepInput[] = [];

  try {
    const cappedResult = capTasks(tasks);
    capped = cappedResult.tasks;
    truncated = cappedResult.truncated;
    if (cappedResult.warning) warnings.push(cappedResult.warning);

    const metas = buildPairs(capped);
    const resolutions: PairResolution[] = metas.map((meta) => ({
      meta,
      choice: ruleChoice(meta.hasKeywordA, meta.hasKeywordB, meta.overlapFiles.length),
      source: "rules",
    }));

    const candidates = resolutions.filter((resolution) => resolution.meta.hints.length > 0);
    let decisionSource: "rules" | "jev" | "hybrid" = "rules";

    if (candidates.length > 0) {
      const answers = await callJev(buildState(capped, metas), buildQuestions(metas), cfg, deps);
      if (answers === null) {
        warnings.push("JEV unavailable — rules-only dependency analysis");
      } else {
        let jevCount = 0;
        let fallbackCount = 0;
        for (const resolution of candidates) {
          const picked = pickChoice(answers[resolution.meta.key], DEP_CHOICES);
          if (picked !== undefined) {
            resolution.choice = picked;
            resolution.source = "jev";
            jevCount += 1;
          } else {
            fallbackCount += 1;
            warnings.push(
              `pair ${resolution.meta.a.id}|${resolution.meta.b.id}: JEV answer invalid/absent — deterministic fallback`,
            );
          }
        }
        if (jevCount > 0 && fallbackCount === 0) decisionSource = "jev";
        else if (jevCount > 0) decisionSource = "hybrid";
        else decisionSource = "rules";
      }
    }

    const pairs: DepPair[] = resolutions.map((resolution) => ({
      a: resolution.meta.a.id,
      b: resolution.meta.b.id,
      hints: resolution.meta.hints,
      overlapFiles: resolution.meta.overlapFiles,
      suggested: resolution.choice,
      source: resolution.source,
    }));

    const dropped: JevDepsDecision["dropped"] = [];
    let edges: InternalEdge[] = [];
    for (const resolution of resolutions) {
      const { meta, choice: picked } = resolution;
      if (picked === "a_first") {
        edges.push({ from: meta.a.id, to: meta.b.id, pairIndex: meta.index });
      } else if (picked === "b_first") {
        edges.push({ from: meta.b.id, to: meta.a.id, pairIndex: meta.index });
      } else if (picked === "none") {
        dropped.push({ a: meta.a.id, b: meta.b.id, reason: "none" });
      }
    }

    const order = capped.map((task) => task.id);
    const rank = makeRanker(capped);

    // Break cycles deterministically: drop the edge with the highest pair index
    // that still participates in a cycle, then recompute.
    let guard = edges.length + 1;
    while (guard > 0) {
      guard -= 1;
      const stuck = stuckNodes(order, edges);
      if (stuck.size === 0) break;
      const victims = edges
        .map((edge, position) => ({ edge, position }))
        .filter(({ edge }) => stuck.has(edge.from) && stuck.has(edge.to));
      if (victims.length === 0) break;
      victims.sort((x, y) => {
        if (y.edge.pairIndex !== x.edge.pairIndex) return y.edge.pairIndex - x.edge.pairIndex;
        return y.position - x.position;
      });
      const victim = victims[0];
      if (victim === undefined) break;
      edges = edges.filter((_, position) => position !== victim.position);
      const pair = metas[victim.edge.pairIndex];
      if (pair !== undefined) {
        dropped.push({ a: pair.a.id, b: pair.b.id, reason: "cycle" });
        warnings.push(
          `cycle detected; dropped dependency ${victim.edge.from}→${victim.edge.to} (pair ${pair.a.id}|${pair.b.id})`,
        );
      }
    }

    const waves = computeWaves(order, edges, rank);

    const suggestions: Record<string, string[]> = {};
    for (const edge of edges) {
      const list = suggestions[edge.to] ?? [];
      if (!list.includes(edge.from)) list.push(edge.from);
      suggestions[edge.to] = list;
    }

    return {
      source: decisionSource,
      pairs,
      edges: edges.map((edge) => ({ from: edge.from, to: edge.to })),
      waves,
      dropped,
      suggestions,
      truncated,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`dependency analysis failed: ${message}`);
    return degradedDecision(capped, truncated, warnings);
  }
}
