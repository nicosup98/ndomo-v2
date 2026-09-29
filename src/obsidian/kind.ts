/**
 * ndomo obsidian — deterministic kind classification (pure, DB-free).
 *
 * Maps the two persisted classification signals (JEV intent + PlanCategory)
 * onto the closed {@link ObsidianKind} vocabulary and resolves the effective
 * kind of a plan / task / memory through a fixed precedence chain.
 *
 * Design (`.ndomo/designs/2026-09-25-obsidian-brain-layer-design.md`):
 * - `../db/types.ts` and `../orchestrator/jev-intent.ts` are imported as TYPES
 *   ONLY (erased at runtime — no orchestrator/SDK/DB dependency), so both
 *   mapping tables are exhaustively checked by the compiler: adding a JEV
 *   intent or a PlanCategory that is not mapped is a `tsc` error instead of a
 *   silent fall-through to `"other"`.
 * - Inside the precedence chain an unknown *string* means "no signal" and the
 *   resolver moves to the next level, so a typo in `metadata` can never shadow
 *   a valid fallback. Direct calls ({@link resolveKindFromJev}) still return
 *   `"other"` for anything outside their taxonomy.
 * - Only `metadata.obsidianKind` validated by {@link isObsidianKind} is an
 *   override; everything else is derived.
 */

import type { PlanCategory } from "../db/types.ts";
import type { JevIntent } from "../orchestrator/jev-intent.ts";
import { isObsidianKind, OBSIDIAN_KINDS, type ObsidianKind } from "./types.ts";

/** JEV intent → kind. Exhaustive over `JevIntent` (compiler-checked). */
const KIND_BY_JEV: Record<JevIntent, ObsidianKind> = {
  bugfix: "bugfix",
  feature: "feature",
  refactor: "refactor",
  question: "research",
  other: "other",
  none: "other",
};

/** `plans.category` → kind (docs/infra keep their own kind). Compiler-checked. */
const KIND_BY_PLAN_CATEGORY: Record<PlanCategory, ObsidianKind> = {
  feature: "feature",
  refactor: "refactor",
  bugfix: "bugfix",
  docs: "docs",
  infra: "infra",
};

/** Metadata key holding an explicit, validated kind override. */
const KIND_OVERRIDE_KEY = "obsidianKind";

/**
 * Map `value` through `map` or report "no signal" (`null`).
 * `Object.hasOwn` (not `in`) keeps the prototype chain out of the lookup.
 */
function lookup<T extends string>(
  map: Record<T, ObsidianKind>,
  value: unknown,
): ObsidianKind | null {
  if (typeof value !== "string" || !Object.hasOwn(map, value)) return null;
  return map[value as T];
}

/** Read one metadata field defensively (metadata may be any JSON shape). */
function metaField(metadata: unknown, key: string): unknown {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))
    return undefined;
  return (metadata as Record<string, unknown>)[key];
}

/** `metadata.obsidianKind` when it is a valid {@link ObsidianKind}, else `null`. */
function metadataOverride(metadata: unknown): ObsidianKind | null {
  const raw = metaField(metadata, KIND_OVERRIDE_KEY);
  return isObsidianKind(raw) ? raw : null;
}

/**
 * Classify from the JEV taxonomy (the 6 real intents).
 * `question` → `research`; `other`/`none`/unknown/absent → `other`.
 */
export function resolveKindFromJev(intent: string | null | undefined): ObsidianKind {
  return lookup(KIND_BY_JEV, intent) ?? "other";
}

/**
 * Classify from a `plans.category` value.
 * `feature|refactor|bugfix` keep their name; `docs`→`docs`, `infra`→`infra`;
 * anything else → `other`.
 */
export function resolveKindFromPlanCategory(category: string | null | undefined): ObsidianKind {
  return lookup(KIND_BY_PLAN_CATEGORY, category) ?? "other";
}

/**
 * Effective kind of a plan. Precedence:
 * `metadata.obsidianKind` (valid) → `metadata.jevIntent` → `metadata.category`
 * → `plan.category` → `other`.
 *
 * `metadata` is typed `unknown` on purpose: real `Plan.metadata` is the
 * `PlanMetadata` interface, which is NOT assignable to `Record<string, unknown>`
 * (interfaces have no implicit index signature) even though the runtime shape
 * is a plain JSON object.
 */
export function resolvePlanKind(plan: {
  metadata?: unknown;
  category?: string | null | undefined;
}): ObsidianKind {
  const override = metadataOverride(plan.metadata);
  if (override !== null) return override;

  const fromJev = lookup(KIND_BY_JEV, metaField(plan.metadata, "jevIntent"));
  if (fromJev !== null) return fromJev;

  const fromMetaCategory = lookup(KIND_BY_PLAN_CATEGORY, metaField(plan.metadata, "category"));
  if (fromMetaCategory !== null) return fromMetaCategory;

  const fromPlanCategory = lookup(KIND_BY_PLAN_CATEGORY, plan.category);
  if (fromPlanCategory !== null) return fromPlanCategory;

  return "other";
}

/**
 * Effective kind of a task: `metadata.obsidianKind` (valid) → the parent
 * plan's kind (already resolved by {@link resolvePlanKind}) → `other`.
 * The `other` fallback only fires when the caller passes `other` as the parent
 * kind — inheritance is total, tasks never re-derive from JEV/category.
 */
export function resolveTaskKind(
  task: { metadata?: unknown },
  parentPlanKind: ObsidianKind,
): ObsidianKind {
  return metadataOverride(task.metadata) ?? parentPlanKind;
}

/** Effective kind of a memory: `metadata.obsidianKind` (valid) → `other`. */
export function resolveMemoryKind(memory: { metadata?: unknown }): ObsidianKind {
  return metadataOverride(memory.metadata) ?? "other";
}

/** Validated caller-supplied `kind?` override (tool argument). */
export type KindOverrideResult = { ok: true; kind: ObsidianKind } | { ok: false; message: string };

/**
 * Validate the `kind?` override accepted by `obsidian_export`.
 * Callers must only invoke this when the argument is present: an absent
 * override (`undefined`) is reported as `ok: false` by contract.
 */
export function validateKindOverride(value: unknown): KindOverrideResult {
  if (isObsidianKind(value)) return { ok: true, kind: value };
  const shown =
    typeof value === "string"
      ? `"${value}"`
      : value === null
        ? "null"
        : value === undefined
          ? "undefined"
          : `a ${typeof value}`;
  return {
    ok: false,
    message: `invalid kind ${shown}; expected one of: ${OBSIDIAN_KINDS.join("|")}`,
  };
}
