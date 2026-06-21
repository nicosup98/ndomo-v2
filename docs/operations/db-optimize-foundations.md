# DB Optimization — P4 Foundations (deferred)

**Date:** 2026-06-21
**Plan:** `craftsman-db-optimize-v1` (`e105c278-a710-48cc-b3d3-23570d594e05`)
**Audit ref:** plan metadata `auditRef` → findings `plan_audit_foundation`, `fts_metadata_foundation`
**Status:** Both items are **Deferred — P4 foundation**. The v12 migration resolved 4 P1–P3 findings; these 2 are documented here for future implementation.

---

## Summary

| # | Finding | Scope | Risk | When to execute |
|---|---------|-------|------|-----------------|
| 1 | `original_plan_data` → `plan_audit` migration | Replace write-once JSON column with proper audit trail | Medium | When audit trail queries become user-facing |
| 2 | `plans_fts_v2` → `plans_fts_v3` with `metadata` column | Add metadata JSON as FTS5-searchable column | Low | When users need to search plans by metadata content |

---

## 1. `original_plan_data` → `plan_audit` migration

### Current state

The `original_plan_data` column exists on both `plans` and `plan_tasks` (added in v6, `src/db/schema.ts:467-473`). It stores a JSON snapshot of the plan/task at creation time. This is a write-once field — set on `INSERT` in `src/db/plans.ts:34` and `src/db/tasks.ts:162`, never updated thereafter. Verified in `src/db/migrations-v8.test.ts:69-76` (status update does NOT overwrite).

### v12 foundation: `plan_audit` table skeleton

Migration v12 creates a `plan_audit` table (skeleton, no data migration yet). The table is designed to replace `original_plan_data` with a proper audit trail supporting multiple snapshots per plan.

### Future migration sketch (v13+)

```sql
-- Migrate original_plan_data from plans into plan_audit
INSERT INTO plan_audit (plan_id, captured_at, snapshot, trigger)
SELECT id, created_at, original_plan_data, 'creation'
FROM plans
WHERE original_plan_data IS NOT NULL;

-- Migrate original_plan_data from plan_tasks into plan_audit (with task context)
-- Note: plan_audit PK is (plan_id, captured_at), so tasks need a different approach
-- Option A: Add task_id column to plan_audit
-- Option B: Create separate task_audit table
-- Decision: deferred to implementation time
```

### Risks and considerations

- **Risk:** Medium. Data migration from a JSON column to an audit table requires careful NULL handling. Plans created before v6 have `original_plan_data = NULL` and must be excluded from the migration (`WHERE original_plan_data IS NOT NULL`).
- **Rollback safety:** The `original_plan_data` column should NOT be dropped immediately after migration. Keep it for at least one version (two release cycles) for rollback safety.
- **Task audit:** `plan_tasks.original_plan_data` introduces a design question: the `plan_audit` PK is `(plan_id, captured_at)`. Tasks need either a `task_id` column added to `plan_audit` (Option A) or a separate `task_audit` table (Option B). Deferred to implementation time.

### When to execute

When audit trail queries become a user-facing feature (e.g., "show me what this plan looked like when it was created"). Currently no consumer reads `original_plan_data` for display — it is only serialized in auto-archive output (`src/db/plan-archive.test.ts:48-61`).

---

## 2. FTS5 `plans_fts_v2` → `plans_fts_v3` with `metadata` column

### Current state

The current `plans_fts_v2` virtual table (recreated in v4, `src/db/schema.ts:442-463`) includes these searchable columns: `id` (UNINDEXED), `title`, `overview`, `approach`, `category`.

The original v1 FTS5 table (`src/db/schema.ts:164-166`) also had a `tags` column, but all triggers populated it with an empty string `''` (`src/db/schema.ts:171,177,181`). The v4 migration dropped the `tags` column when it recreated the table.

The `metadata` column on `plans` (`src/db/schema.ts` — added in v2, stores JSON) is currently NOT indexed in FTS5. Plans cannot be searched by metadata content.

### Future migration sketch (v13+)

```sql
-- Drop v2 FTS + triggers
DROP TRIGGER IF EXISTS plans_v2_ai;
DROP TRIGGER IF EXISTS plans_v2_ad;
DROP TRIGGER IF EXISTS plans_v2_au;
DROP TABLE IF EXISTS plans_fts_v2;

-- Create v3 FTS with metadata column
CREATE VIRTUAL TABLE plans_fts_v3 USING fts5(
  id UNINDEXED, title, overview, approach, category, tags, metadata,
  content='plans', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 1'
);

-- New triggers with metadata
CREATE TRIGGER plans_v3_ai AFTER INSERT ON plans BEGIN
  INSERT INTO plans_fts_v3(rowid, id, title, overview, approach, category, tags, metadata)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '', COALESCE(new.metadata, '{}'));
END;

CREATE TRIGGER plans_v3_ad AFTER DELETE ON plans BEGIN
  INSERT INTO plans_fts_v3(plans_fts_v3, rowid, id, title, overview, approach, category, tags, metadata)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '', COALESCE(old.metadata, '{}'));
END;

CREATE TRIGGER plans_v3_au AFTER UPDATE ON plans BEGIN
  INSERT INTO plans_fts_v3(plans_fts_v3, rowid, id, title, overview, approach, category, tags, metadata)
  VALUES ('delete', old.rowid, old.id, old.title, old.overview, old.approach, old.category, '', COALESCE(old.metadata, '{}'));
  INSERT INTO plans_fts_v3(rowid, id, title, overview, approach, category, tags, metadata)
  VALUES (new.rowid, new.id, new.title, new.overview, new.approach, new.category, '', COALESCE(new.metadata, '{}'));
END;

-- Rebuild from content table
INSERT INTO plans_fts_v3(plans_fts_v3) VALUES ('rebuild');
```

### Drop+recreate cost

FTS5 virtual tables cannot be `ALTER`ed. Must `DROP` + `CREATE`. The `rebuild` command re-indexes from the content table at O(n) where n = number of plans. For current scale (<10K plans), this is instant. For future scale (>100K plans), execute during low-traffic periods.

### When to execute

When users need to search plans by metadata content (e.g., "find all plans with `category=refactor`"). Currently the `category` column is indexed in FTS5, but `metadata` JSON values are not searchable. The `tags` column is re-added in this sketch for future use but remains populated with `''` for now.

---

## References

- Plan: `craftsman-db-optimize-v1` (`e105c278-a710-48cc-b3d3-23570d594e05`)
- Source: `src/db/schema.ts` — v4 FTS5 recreation (lines 434-463), v6 `original_plan_data` (lines 467-473)
- Source: `src/db/migrations.ts` — v6 migration logic (lines 48-51)
- Source: `src/db/plans.ts` — `original_plan_data` INSERT (line 34)
- Source: `src/db/tasks.ts` — `original_plan_data` INSERT (line 162)
- Tests: `src/db/migrations-v8.test.ts` — write-once verification (lines 52-130)
- Tests: `src/db/plan-archive.test.ts` — original_plan_data in archive serialization (lines 48-61)
