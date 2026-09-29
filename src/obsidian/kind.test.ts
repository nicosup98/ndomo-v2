/**
 * Tests for obsidian kind classification.
 *
 * Exhaustive over the REAL taxonomies: `JEV_INTENTS` is imported from the
 * orchestrator (6 values) and the PlanCategory list mirrors
 * `src/db/types.ts`, so a taxonomy change breaks this suite instead of
 * silently degrading to "other". Also covers the full precedence chains,
 * invalid metadata fall-through and the tool-level `kind?` override.
 */

import { describe, expect, test } from "bun:test";
import { JEV_INTENTS } from "../orchestrator/jev-intent.ts";
import {
  resolveKindFromJev,
  resolveKindFromPlanCategory,
  resolveMemoryKind,
  resolvePlanKind,
  resolveTaskKind,
  validateKindOverride,
} from "./kind.ts";
import type { ObsidianKind } from "./types.ts";

/** Expected mapping for every real JEV intent (spec of OBL-2). */
const EXPECTED_JEV: Record<(typeof JEV_INTENTS)[number], ObsidianKind> = {
  bugfix: "bugfix",
  feature: "feature",
  refactor: "refactor",
  question: "research",
  other: "other",
  none: "other",
};

/** Mirror of `PlanCategory` (`src/db/types.ts`), which has no runtime array. */
const PLAN_CATEGORIES = ["feature", "refactor", "bugfix", "docs", "infra"] as const;

const EXPECTED_CATEGORY: Record<(typeof PLAN_CATEGORIES)[number], ObsidianKind> = {
  feature: "feature",
  refactor: "refactor",
  bugfix: "bugfix",
  docs: "docs",
  infra: "infra",
};

describe("resolveKindFromJev", () => {
  test("covers all 6 real JEV intents", () => {
    expect(JEV_INTENTS).toHaveLength(6);
    for (const intent of JEV_INTENTS) {
      expect(resolveKindFromJev(intent)).toBe(EXPECTED_JEV[intent]);
    }
  });

  test("question maps to research (not question — that is not a kind)", () => {
    expect(resolveKindFromJev("question")).toBe("research");
  });

  test("unknown / absent / nullish inputs fall back to other", () => {
    expect(resolveKindFromJev("banana")).toBe("other");
    expect(resolveKindFromJev("")).toBe("other");
    expect(resolveKindFromJev("FEATURE")).toBe("other");
    expect(resolveKindFromJev("toString")).toBe("other");
    expect(resolveKindFromJev(null)).toBe("other");
    expect(resolveKindFromJev(undefined)).toBe("other");
  });
});

describe("resolveKindFromPlanCategory", () => {
  test("covers every PlanCategory", () => {
    expect(PLAN_CATEGORIES).toHaveLength(5);
    for (const category of PLAN_CATEGORIES) {
      expect(resolveKindFromPlanCategory(category)).toBe(EXPECTED_CATEGORY[category]);
    }
  });

  test("docs and infra keep their own kind", () => {
    expect(resolveKindFromPlanCategory("docs")).toBe("docs");
    expect(resolveKindFromPlanCategory("infra")).toBe("infra");
  });

  test("unknown / absent / nullish categories fall back to other", () => {
    expect(resolveKindFromPlanCategory("research")).toBe("other");
    expect(resolveKindFromPlanCategory("banana")).toBe("other");
    expect(resolveKindFromPlanCategory(null)).toBe("other");
    expect(resolveKindFromPlanCategory(undefined)).toBe("other");
  });
});

describe("resolvePlanKind precedence", () => {
  test("metadata.obsidianKind wins over every other signal", () => {
    expect(
      resolvePlanKind({
        metadata: { obsidianKind: "docs", jevIntent: "bugfix", category: "infra" },
        category: "feature",
      }),
    ).toBe("docs");
  });

  test("metadata.jevIntent wins over metadata.category and plans.category", () => {
    expect(
      resolvePlanKind({
        metadata: { jevIntent: "question", category: "infra" },
        category: "feature",
      }),
    ).toBe("research");
  });

  test("metadata.category wins over plans.category", () => {
    expect(resolvePlanKind({ metadata: { category: "docs" }, category: "infra" })).toBe("docs");
  });

  test("plans.category is the last signal before other", () => {
    expect(resolvePlanKind({ category: "bugfix" })).toBe("bugfix");
    expect(resolvePlanKind({ metadata: null, category: "docs" })).toBe("docs");
  });

  test("no signal at all resolves to other", () => {
    expect(resolvePlanKind({})).toBe("other");
    expect(resolvePlanKind({ metadata: null })).toBe("other");
    expect(resolvePlanKind({ metadata: {}, category: null })).toBe("other");
    expect(resolvePlanKind({ metadata: [], category: undefined })).toBe("other");
    expect(resolvePlanKind({ metadata: "not-an-object" })).toBe("other");
  });

  test("an invalid obsidianKind falls through to the next level", () => {
    expect(resolvePlanKind({ metadata: { obsidianKind: "banana" } })).toBe("other");
    expect(resolvePlanKind({ metadata: { obsidianKind: "banana", jevIntent: "question" } })).toBe(
      "research",
    );
    expect(
      resolvePlanKind({ metadata: { obsidianKind: 42, category: "infra" }, category: "docs" }),
    ).toBe("infra");
  });

  test("unknown jevIntent / category strings do not shadow valid fallbacks", () => {
    expect(resolvePlanKind({ metadata: { jevIntent: "auth_feature" }, category: "docs" })).toBe(
      "docs",
    );
    expect(resolvePlanKind({ metadata: { category: "security" }, category: "infra" })).toBe(
      "infra",
    );
    expect(resolvePlanKind({ metadata: { jevIntent: "none" } })).toBe("other");
  });

  test("metadata.jevIntent is mapped, not copied verbatim", () => {
    expect(resolvePlanKind({ metadata: { jevIntent: "bugfix" } })).toBe("bugfix");
    expect(resolvePlanKind({ metadata: { jevIntent: "feature" } })).toBe("feature");
    expect(resolvePlanKind({ metadata: { jevIntent: "refactor" } })).toBe("refactor");
  });
});

describe("resolveTaskKind", () => {
  test("inherits the parent plan kind when there is no override", () => {
    expect(resolveTaskKind({}, "feature")).toBe("feature");
    expect(resolveTaskKind({ metadata: null }, "research")).toBe("research");
    expect(resolveTaskKind({ metadata: { status: "running" } }, "infra")).toBe("infra");
  });

  test("metadata.obsidianKind overrides the parent kind", () => {
    expect(resolveTaskKind({ metadata: { obsidianKind: "docs" } }, "feature")).toBe("docs");
  });

  test("an invalid override falls back to the parent kind", () => {
    expect(resolveTaskKind({ metadata: { obsidianKind: "banana" } }, "bugfix")).toBe("bugfix");
    expect(resolveTaskKind({ metadata: { obsidianKind: null } }, "other")).toBe("other");
  });

  test("other parent kind stays other (inheritance is total)", () => {
    expect(resolveTaskKind({}, "other")).toBe("other");
  });
});

describe("resolveMemoryKind", () => {
  test("defaults to other", () => {
    expect(resolveMemoryKind({})).toBe("other");
    expect(resolveMemoryKind({ metadata: null })).toBe("other");
    expect(resolveMemoryKind({ metadata: { type: "decision" } })).toBe("other");
  });

  test("honors a valid metadata.obsidianKind override", () => {
    expect(resolveMemoryKind({ metadata: { obsidianKind: "research" } })).toBe("research");
  });

  test("an invalid override resolves to other", () => {
    expect(resolveMemoryKind({ metadata: { obsidianKind: "banana" } })).toBe("other");
    expect(resolveMemoryKind({ metadata: { obsidianKind: 7 } })).toBe("other");
  });
});

describe("validateKindOverride", () => {
  test("accepts every value of the closed vocabulary", () => {
    const kinds: ObsidianKind[] = [
      "feature",
      "bugfix",
      "refactor",
      "infra",
      "design",
      "docs",
      "research",
      "other",
    ];
    for (const kind of kinds) {
      expect(validateKindOverride(kind)).toEqual({ ok: true, kind });
    }
  });

  test("rejects values outside the vocabulary with a readable message", () => {
    const invalid = validateKindOverride("banana");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.message).toContain('"banana"');
      expect(invalid.message).toContain("feature|bugfix");
    }
  });

  test("rejects non-strings", () => {
    expect(validateKindOverride(42).ok).toBe(false);
    expect(validateKindOverride(null).ok).toBe(false);
    expect(validateKindOverride(undefined).ok).toBe(false);
    expect(validateKindOverride({ kind: "docs" }).ok).toBe(false);
  });
});
