/**
 * ndomo spec — single import surface for the spec module.
 *
 * `src/plugin.ts` (spec_create/spec_get/spec_lint), `src/cli/spec.ts` and the
 * T0 gate in `src/db/plans.ts` must import exclusively from this barrel.
 *
 * Modules:
 *  - `template.ts` — canonical template, path/index helpers, createSpec (fs).
 *  - `parse.ts`    — pure markdown → SpecDocument parser (frontmatter,
 *                    sections, REQ/AC, traceability matrix; fence-aware).
 *  - `lint.ts`     — deterministic linter, rules L0–L9 (SPEC-001 §7).
 *  - `serialize.ts`— pure SpecDocument → canonical markdown.
 */

export * from "./lint.ts";
export * from "./parse.ts";
export * from "./serialize.ts";
export * from "./template.ts";
