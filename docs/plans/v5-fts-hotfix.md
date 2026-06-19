---
plan name: v5-fts-hotfix
plan description: Fix FTS rank + archived filters
plan status: active
---

## Idea
Fix 5 post-auditoría issues: searchPlans sin ORDER BY rank, nextTaskForAgent/findPlansByTag/findPlansByCategory sin filtro archived, plan_progress view contando archived tasks. Stack TS+Bun+bun:sqlite.

## Implementation
- 1. Edit src/db/plans.ts searchPlans: JOIN plans_fts_v2 + ORDER BY rank
- 2. Edit src/db/tasks.ts nextTaskForAgent: add opts + filter archived_at IS NULL
- 3. Edit src/db/plans.ts findPlansByTag: add includeArchived opt + filter
- 4. Edit src/db/plans.ts findPlansByCategory: add includeArchived opt + filter
- 5. Edit src/db/schema.ts SCHEMA_V5_SQL: add DROP/CREATE plan_progress view with archived filter
- 6. Update scripts/smoke-v5.ts: add 4 new asserts for rank, archived filter, progress view
- 7. Run tsc --noEmit, biome check, smoke v4 + v5

## Required Specs
<!-- SPECS_START -->
<!-- SPECS_END -->