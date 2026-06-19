# Database & Plans

## Overview

ndomo persists plans, tasks, and sessions in a project-local SQLite database
located at `<project>/.ndomo/state.db` (`src/db/client.ts:12-13`). Created
automatically on first plugin load via `openDb(projectDir)` (`src/db/client.ts:15-20`).
Survives OpenCode restarts. Indexed with FTS5 for full-text search.

### What gets stored

- **Plans** — long-running initiatives with a slug, status (draft/approved/executing/completed/failed/abandoned),
  priority (1-4), complexity (1-5), category, and audit trail
- **Tasks** — atomic units of work assigned to a specific agent, with
  dependencies (by order_index), result/error fields, and artifacts
- **Sessions** — continuity across agent dispatches, with checkpoints,
  agent history, and key decisions

### What is NOT stored here

- `~/.ndomo/mem/` is the **opencode-mem** plugin's storage (USearch vector DB
  for semantic memory, configured via `ndomo.json` `mem.storagePath`)
- `docs/plans/<slug>.md` is the **opencode-planning-toolkit** markdown storage
  (different system, simpler, git-friendly)
- The ndomo DB archive output goes to `~/.ndomo/mem/plans/` (markdown snapshots)

## Schema

### Tables

#### `plans`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `slug` | TEXT UNIQUE | kebab-case, 1-60 chars, validated via trigger (`src/db/schema.ts:257-268`) |
| `title` | TEXT | Short actionable phrase |
| `status` | TEXT | CHECK: `draft`, `approved`, `executing`, `completed`, `failed`, `abandoned` |
| `priority` | INTEGER | 1-4, validated via trigger (`src/db/schema.ts:244-254`) |
| `created_at` | INTEGER | Epoch ms |
| `updated_at` | INTEGER | Auto-updated via trigger (`src/db/schema.ts:205-209`) |
| `approved_at` | INTEGER | Null until approved |
| `completed_at` | INTEGER | Null until terminal status |
| `session_id` | TEXT | FK to sessions (app-level validation, `src/db/plans.ts:118-121`) |
| `overview` | TEXT | 2-4 line description |
| `approach` | TEXT | Implementation strategy |
| `complexity` | INTEGER | 1-5 |
| `metadata` | JSON | Discriminated via `PlanMetadata` type |
| `created_by` | TEXT | Agent name |
| `updated_by` | TEXT | Agent name |
| `source_session_id` | TEXT | Originating session |
| `source_message_id` | TEXT | Originating message ID |
| `category` | TEXT | CHECK: `feature`, `refactor`, `bugfix`, `docs`, `infra` |
| `archived_at` | INTEGER | Null when active, epoch ms when archived (v5 soft delete) |

Indexes: `idx_plans_status`, `idx_plans_session`, `idx_plans_created`,
`idx_plans_status_priority`, `idx_plans_archived`.

#### `plan_tasks`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `plan_id` | TEXT FK | References `plans(id)` ON DELETE CASCADE |
| `order_index` | INTEGER | Sequential within plan. UNIQUE(plan_id, order_index) |
| `description` | TEXT | Task description |
| `agent` | TEXT | Assigned agent name |
| `files` | JSON | Expected output files `[]` |
| `complexity` | INTEGER | 1-5 |
| `status` | TEXT | CHECK: `pending`, `running`, `done`, `failed`, `blocked` |
| `started_at` | INTEGER | Epoch ms, set when `running` |
| `completed_at` | INTEGER | Epoch ms, set when `done` or `failed` |
| `result` | TEXT | Free text, truncated to 16KB (`src/db/tasks.ts:109-121`) |
| `error` | TEXT | Error message, truncated to 16KB |
| `dependencies` | JSON | Array of order_index values |
| `metadata` | JSON | Discriminated via `TaskMetadata` type, default `'{}'` |
| `created_by` | TEXT | Agent name |
| `updated_by` | TEXT | Agent name |
| `source_session_id` | TEXT | Originating session |
| `source_message_id` | TEXT | Originating message ID |
| `reviewed_by` | TEXT | Reviewer agent name |
| `tokens_used` | INTEGER | Token count for this task |
| `duration_ms` | INTEGER | Execution duration |
| `artifacts` | JSON | Array of artifact paths |
| `archived_at` | INTEGER | Null when active (v5 soft delete) |

Indexes: `idx_tasks_plan`, `idx_tasks_status`, `idx_tasks_agent`,
`idx_tasks_plan_status`, `idx_tasks_agent_status`, `idx_tasks_archived`.

#### `sessions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `started_at` | INTEGER | Epoch ms |
| `ended_at` | INTEGER | Null until ended |
| `last_checkpoint` | INTEGER | Updated by `checkpointSession()` via trigger (`src/db/schema.ts:218-223`) |
| `plan_id` | TEXT | References `plans(id)` ON DELETE SET NULL |
| `goal` | TEXT | Session goal description |
| `state` | JSON | Arbitrary checkpoint state `{}` |
| `agent_history` | JSON | Array of `{agent, taskId, startedAt, endedAt}` |
| `key_decisions` | TEXT | Free text decision log |
| `metadata` | JSON | Discriminated via `SessionMetadata` type |
| `created_by` | TEXT | Agent name |
| `source_message_id` | TEXT | Originating message ID |
| `parent_session_id` | TEXT | Self-referencing FK |
| `outcome` | TEXT | CHECK: `success`, `partial`, `failed`, `abandoned` |
| `archived_at` | INTEGER | Null when active (v5 soft delete) |

Indexes: `idx_sessions_started`, `idx_sessions_plan`, `idx_sessions_archived`.

### FTS5 indexes

- **`plans_fts_v2`** — content=`plans` (external), columns `id` (UNINDEXED), `title`,
  `overview`, `approach`, `category`. Tokenizer: `unicode61 remove_diacritics 1`.
  Auto-synced via `AFTER INSERT/UPDATE/DELETE` triggers (`src/db/schema.ts:441-463`).
- **`tasks_fts`** — content=`plan_tasks` (external), columns `id` (UNINDEXED), `description`,
  `result`, `error`. Same tokenizer. Auto-synced via triggers (`src/db/schema.ts:345-363`).

Query escaping: `escapeFtsQuery()` wraps user input in double quotes to prevent
FTS5 syntax injection from hyphens and special characters (`src/db/fts-escape.ts:18-19`).

### Tag tables (M:N)

- **`plan_tags(plan_id, tag, added_by, added_at)`** — PK `(plan_id, tag)`.
  Indexed on `tag`. Insert with `OR IGNORE` for idempotency.
- **`task_tags(task_id, tag, added_by, added_at)`** — PK `(task_id, tag)`.
  Indexed on `tag`. Same idempotent insert pattern.

### View

- **`plan_progress`** — computed from `plans` LEFT JOIN `plan_tasks` (excluding
  archived tasks, `src/db/schema.ts:413-431`). Columns: `plan_id`, `slug`, `title`,
  `status`, `total_tasks`, `done`, `failed`, `running`, `pending`, `blocked`,
  `progress_pct` (percentage rounded to integer).

### Migrations

5 migrations applied automatically by `runMigrations(db)` ordered by version:

| Version | Description |
|---|---|
| v1 | Initial schema: plans, plan_tasks, sessions, FTS5 (porter), sync triggers |
| v2 | Discriminated metadata, audit columns, plan_tags/task_tags M:N, plans_fts_v2 (contentless) |
| v3 | `updated_at` triggers, composite indexes, session FK app-level validation |
| v4 | Priority/slug validation triggers, `plan_progress` view, FTS5 unicode61 diacritics, Spanish stopwords table, metadata default trigger |
| v5 | Soft delete (`archived_at` columns), `plans_fts_v2` switched to external content (`content='plans'`), `plan_progress` excludes archived tasks |

`SCHEMA_V5_SQL` note: columns are added via `addColumnIfMissing()` in `migrations.ts`
because SQLite 3.45 lacks `IF NOT EXISTS` for `ALTER TABLE ADD COLUMN` (`src/db/schema.ts:400-403`).

## Tools (14)

### Plans (6)

| Tool | Args | Returns |
|---|---|---|
| `plan_create` | `slug`, `title`, `overview`, `approach?`, `priority?`, `complexity?`, `sessionId?`, `metadata?` | `Plan` (JSON) |
| `plan_get` | `id?` OR `slug?` | `Plan \| null` (JSON) |
| `plan_list` | `status?`, `sessionId?`, `limit?` | `Plan[]` (JSON) |
| `plan_search` | `query`, `limit?`, `includeArchived?` | `Plan[]` (JSON, FTS5 ranked) |
| `plan_approve` | `id` | `Plan \| null` (JSON) |
| `plan_update_status` | `id`, `status` (enum: `draft`/`approved`/`executing`/`completed`/`failed`/`abandoned`) | `{plan, archived, archiveError}` (JSON) |

- `plan_create` generates a UUID v4 internally via `crypto.randomUUID()` (`src/plugin.ts:457`).
- `plan_update_status` auto-archives when status is `completed`, `failed`, or `abandoned`
  (`src/plugin.ts:564-575`). Archive errors are non-blocking (logged as warning).

### Tasks (5)

| Tool | Args | Returns |
|---|---|---|
| `task_create_batch` | `planId`, `tasks[]` (array of `{description, agent, files?, complexity?, dependencies?, metadata?}`) | `PlanTask[]` (JSON) |
| `task_list` | `planId`, `status?` | `PlanTask[]` (JSON) |
| `task_update_status` | `id`, `status` (enum), `result?`, `error?` | `PlanTask \| null` (JSON) |
| `task_search` | `query`, `limit?`, `includeArchived?` | `PlanTask[]` (JSON, FTS5 ranked) |
| `task_next_for_agent` | `agent`, `planId?` | `PlanTask \| null` (JSON) |

- `task_create_batch` is transactional — all tasks insert or none (`src/db/tasks.ts:24-77`).
  Status defaults to `pending`. Each task gets a UUID and sequential `order_index`.
- `task_update_status` truncates `result` and `error` to 16KB max (`"…[truncated]"` suffix,
  `src/db/tasks.ts:109-121`). Sets `started_at` on `running`, `completed_at` on `done`/`failed`.
- `task_next_for_agent` returns the first `pending` task ordered by `order_index`
  for the given agent, optionally scoped to a plan.

### Sessions (3)

| Tool | Args | Returns |
|---|---|---|
| `session_start` | `id`, `goal`, `planId?`, `metadata?` | `Session` (JSON) |
| `session_checkpoint` | `id`, `state` (record), `keyDecisions?` | `Session \| null` (JSON) |
| `session_end` | `id` | `Session \| null` (JSON) |

- `session_start` sets `started_at` and `last_checkpoint` to now (`src/db/sessions.ts:24-38`).
- `session_checkpoint` updates `last_checkpoint`, `state`, and appends `key_decisions`
  using `COALESCE(?, key_decisions)` to preserve existing decisions (`src/db/sessions.ts:81-85`).
- `session_end` sets `ended_at` only if not already set (`WHERE ended_at IS NULL`,
  `src/db/sessions.ts:110`). Returns `null` if already ended.

## Lifecycle

### Foreman 10-step lifecycle (`agents/foreman.md`)

```
User → foreman
  |  1. Receive user request (clarify if ambiguous)
  |  2. plan_create("draft") — UUID, slug, priority, overview, approach
  |  3. plan_approve — seal approved_at, transition to "approved"
  |  4. task_create_batch — one task per agent with dependencies
  |  5. session_start — link to planId
  |  6. Dispatch loop:
  |       task_next_for_agent → agent executes → task_update_status
  |  7. session_checkpoint — at each milestone (min 1 per phase)
  |  8. Reconcile — verify all tasks done/failed before closing
  |  9. plan_update_status("completed") — triggers auto-archive
  |  10. session_end — set ended_at
  ↓
Done
```

### Auto-archive

- **Trigger**: `plan_update_status` when `status` ∈ `{completed, failed, abandoned}`
  (`src/plugin.ts:564-568`).
- **Output**: Markdown file at `~/.ndomo/mem/plans/<slug>-YYYY-MM-DD.md` with:
  - Title, slug, status, priority, complexity, plan ID
  - Overview and approach sections
  - Task list with checkboxes (`[x]` for done), agent, complexity, status, result, error
  - Session list with timestamps, goal, and key decisions
  - Metadata as JSON block
- **Collision handling**: If filename exists, appends HHMMSS suffix (`src/db/plan-archive.ts:180-190`).
- **Transactional**: DB update wrapped in `db.transaction()`. Markdown file deleted on
  DB failure (rollback, `src/db/plan-archive.ts:222-229`).
- **Non-blocking**: Archive errors are caught and logged as warnings; status update
  succeeds regardless (`src/plugin.ts:571-574`).
- **DB effect**: Sets `archived_at` on plan, all its tasks, and linked sessions via
  cascade UPDATE (`src/db/plan-archive.ts:196-219`).
- **Filters**: Archived records are excluded by default. Pass `includeArchived: true`
  to `plan_search`, `task_search`, `task_list`, `task_next_for_agent` to retrieve them.
  `plan_list` does not currently expose `includeArchived` in the tool schema.

## Dual plan system

| System | Storage | Purpose |
|---|---|---|
| ndomo plugin DB | `<project>/.ndomo/state.db` (SQLite) | Structured plans with FTS5 search, audit trail, tag taxonomy, cascade archive |
| opencode-planning-toolkit | `docs/plans/<slug>.md` (markdown) | Lightweight plan notes, git-committable, human-readable |
| opencode-mem | `~/.ndomo/mem/` (USearch vector DB) | Semantic memory for cross-session recall, not plans |

These are complementary. Use ndomo DB for orchestration (plans → tasks → sessions);
use planning-toolkit for plan-as-document; use opencode-mem for semantic recall.

## Inspection

```bash
# Count records by status
sqlite3 .ndomo/state.db "SELECT status, COUNT(*) FROM plans GROUP BY status"
sqlite3 .ndomo/state.db "SELECT agent, status, COUNT(*) FROM plan_tasks GROUP BY agent, status"

# Find plans by tag
sqlite3 .ndomo/state.db "SELECT p.title, p.status FROM plans p JOIN plan_tags t ON t.plan_id = p.id WHERE t.tag = 'refactor'"

# FTS5 search
sqlite3 .ndomo/state.db "SELECT title FROM plans_fts_v2 WHERE plans_fts_v2 MATCH 'auth'"

# View progress
sqlite3 .ndomo/state.db "SELECT slug, total_tasks, done, progress_pct FROM plan_progress ORDER BY progress_pct DESC"
```

## Backup & migration

The DB is project-local at `<project>/.ndomo/state.db`. To backup:

```bash
cp .ndomo/state.db ~/.ndomo/backups/state-$(date +%Y%m%d).db
```

Archived plans live at `~/.ndomo/mem/plans/<slug>-YYYY-MM-DD.md` — these are
git-friendly and survive DB deletion.

Migrations are applied automatically by `runMigrations(db)` on plugin startup.
The `schema_version` table tracks applied versions. Manual migration is not
required.
