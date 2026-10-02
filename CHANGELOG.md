# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0](https://github.com/nicosup98/ndomo-v2/compare/v0.7.0...v0.8.0) (2026-10-02)


### Features

* **agents:** wire task_escalate escalation protocol (F4 D3) ([0dc9dd8](https://github.com/nicosup98/ndomo-v2/commit/0dc9dd8d9841910b0676b605af72a5f5089e0105))
* **audit:** self-audit core checks + docs count fixes (F3 harness-intelligence-pack) ([faaa0a3](https://github.com/nicosup98/ndomo-v2/commit/faaa0a3e2e79c561ad5cfc19aaed080f0b316855))
* **cli:** ndomo audit command + audit tests (F3.1 harness-intelligence-pack) ([1c9c027](https://github.com/nicosup98/ndomo-v2/commit/1c9c027941ccb760491d8762c8caa76feecd1721))
* **cli:** ndomo stats agent scorecard + MCP stats tool (F2 harness-intelligence-pack) ([10dc2fd](https://github.com/nicosup98/ndomo-v2/commit/10dc2fd642170d4dcb97281e3e4e4464477c88e8))
* d2 diagrams as documentation (design_create + chronicler + obsidian + CI) ([15fd1ae](https://github.com/nicosup98/ndomo-v2/commit/15fd1ae0ebc872d6d7c9387d5b714ca64384c5a8))
* **orchestrator:** history-aware routing with JEV score (F1 harness-intelligence-pack) ([05e7574](https://github.com/nicosup98/ndomo-v2/commit/05e75747779328b08503a0a63383ff43b6139e20))
* **orchestrator:** route history memo TTL 30s + mutation hooks (F1 routing-history-cache) ([190c3f1](https://github.com/nicosup98/ndomo-v2/commit/190c3f1c794492e2a39f67ed618405b5850fe24b))
* **routing-events:** register route decisions + stats --routing (harness-intelligence fase 2) ([9498fcf](https://github.com/nicosup98/ndomo-v2/commit/9498fcf131a03a3001b64426006840e5818d8ac2))
* **skills:** add bundled ndomo operating guide ([7c52d61](https://github.com/nicosup98/ndomo-v2/commit/7c52d6172f1a234400e0c1b965086c5f5bd70446))


### Bug Fixes

* **agents:** align frontmatter with config preset (F2 D2) ([9a8fae7](https://github.com/nicosup98/ndomo-v2/commit/9a8fae7325813cf73030e5a3f5f19a555df66007))
* **cli:** register analyses command, drop orphan bin/ shims (F1 D5) ([4300830](https://github.com/nicosup98/ndomo-v2/commit/43008304fb5457085c357bb67392a2fdcba3d10b))
* **orchestrator:** rerank reason compares winner vs base agent score (F1 follow-up) ([cdd9198](https://github.com/nicosup98/ndomo-v2/commit/cdd919890dcfadfaf2c1d72e60334480398f19ec))

## [0.5.1] - 2026-09-22

### Changed

- Unified the seven code-smith agents (`smith`, `go-smith`, `js-smith`,
  `python-smith`, `vue-smith`, `zig-smith`, `rust-smith`) on
  `opencode-go/deepseek-v4.1-flash` in the default preset — both in
  `config/ndomo.config.json` and in the agent frontmatter — keeping
  `temperature: 0.1` and `reasoning_effort: high`.

## [Unreleased]

## [0.8.1] - 2026-10-02

### Added

- **`ndomo` skill** — bundled operating guide for the ndomo ecosystem
  (`skills/ndomo/SKILL.md`): decision tree, plan/task/session cycles, gates
  T1-T5, memory, routing, worktrees, ops warden, Obsidian and a compact
  reference for the 62 tools; README/README.es updated to 26 bundled skills.

## [0.8.0] - 2026-10-02

### Added

- **Harness Intelligence pack** — history-aware routing: JEV-scored `route`
  decisions informed by agent outcome history, with an in-process memo
  (TTL 30s) invalidated on plan/task mutations; `routing_events` registry
  (v18 migration, FIFO cap 5000) linking route decisions to task outcomes;
  `ndomo stats --routing` coverage report (7d/30d/all; linked | inferred 24h
  | orphan).
- **`ndomo stats`** — agent scorecard CLI command + MCP `stats` tool
  (success, verify, durations, failure modes per agent).
- **`ndomo audit`** — report-only self-audit CLI (`--json`,
  `--update-manifest`) checking frontmatter↔preset drift, permissions, docs
  counts and DB migrations; exit 1 only when the report has ERROR findings.
- **D2 diagrams as documentation** — `design_create` optional `diagrams`
  parameter serialized into a managed `## Diagrams` section (best-effort d2
  validation), chronicler d2 workflow + `d2-diagrams` skill, `docs/diagrams/`
  sources, `scripts/render-diagrams.sh` and a `d2.yml` CI gate.
- **Escalation protocol wiring (R7)** — craftsman/foreman prompts now invoke
  `task_escalate` on blocked states; feature doc marks R7 resolved (prompt
  wiring, no code changes).

### Changed

- Docs refresh: README (62 MCP tools, `stats`/`audit` commands), database
  schema v18 (`routing_events`), harness-intelligence feature doc and
  workflow propagation.
- Stale debt docs corrected (F3 D1): `plan_files` multi-role resolved v10,
  plan-create orphan FK live mitigation, order-index collision refs, OpenCode
  v2 audit (`tools/`, `src/sdk/`, `src/http/` marked historical).
- `ndomo analyses` registered in the CLI COMMANDS table; orphan
  `bin/ndomo-*` shims removed.

### Fixed

- Agent frontmatter aligned with `config/ndomo.config.json` default preset —
  11 drift fields (models/temperatures) across 10 agents; audit drift 11 → 0.
- Routing rerank rationale now compares the winner against the base agent
  score.

## [0.7.0] - 2026-09-29

### Added

- **Obsidian Brain Layer** — `obsidian_export` / `obsidian_read_note`
  tools (61 tools total): deterministic projection of ndomo state
  (plans, tasks, designs, memories) to an external Obsidian vault
  (`Projects/<projectTag>/...`), SHA-256 sync-state idempotency,
  inside-repo guard, human-edit preservation via
  `%% ndomo:auto:start %%` / `%% ndomo:auto:end %%` markers.

### Removed

- **BREAKING: HTTP server** — Elysia REST/SSE server, SPA fallback,
  `src/http/**`, `ndomo serve` CLI command, `src/sdk/client.ts`, HTTP
  config (`loadHttpConfig`, `NDOMO_HTTP_*` env vars), installer HTTP
  prompt, `scripts/smoke-http.sh`.
- **BREAKING: Web UI** — Vue 3 SPA (`web/**`), `web:*` npm scripts,
  `scripts/smoke-web.sh`, `docs/web-ui.md`, `docs/http-server.md`.
- **Dependencies** — `elysia`, `bulma`, `@opencode/client` + 9 web-only
  devDeps (vite/vitest/vue family).

## [0.6.0] - 2026-09-23

### Added

- **JEV classifier toolkit** — 4 new plugin tools backed by
  `src/orchestrator/jev-{intent,tests,risk,deps}.ts` + `risk-patterns.ts`:
  `classify_intent`, `classify_tests`, `code_traffic_light`,
  `validate_task_dependencies` (deterministic heuristics + tests).
- **Embedded memory system** — SQLite + FTS5 + FlexSearch store
  (`src/mem/{store,schema,search,tags,migrate}.ts`) replaces the
  `opencode-mem` plugin: tools `mem_add`, `mem_search`, `mem_list`,
  `mem_forget`, `mem_stats`; 394 memories migrated with `ndomo_` tags
  (`scripts/migrate-memory.ts`).
- **Ranger agent** — 4th primary agent (`mode: primary`, `model:
  minimax/MiniMax-M3`, `temp: 0.3`) for analysis/cartography/onboarding
  workflows. Read-write guard rails: `edit: deny` for source code,
  `write: ask`, `bash: ask` with read-only allowlist. Delegates to
  `scout` / `sage` / `scribe` for mapping and research.
- **`analyses` table + FTS5** — standalone SQLite table for persisted
  research output (slug, title, project_path, summary, findings_json,
  source_plan_id, agent, session_id, archived_at). External-content
  FTS5 index over `title` + `summary` + `findings_json` with sync
  triggers. Migration v14.
- **Analysis CRUD module** (`src/db/analyses.ts`) — `createAnalysis`,
  `getAnalysis`, `getAnalysisBySlug`, `listAnalyses`, `searchAnalyses`
  (FTS), `updateAnalysis`, `archiveAnalysis`, `linkAnalysisToPlan`,
  `unlinkAnalysisFromPlan`. 40 unit tests covering FK validation,
  FTS sync, soft-delete, and slug uniqueness.
- **7 analysis tools** registered in the OpenCode plugin:
  `analysis_create`, `analysis_get`, `analysis_list`,
  `analysis_search`, `analysis_update`, `analysis_archive`,
  `analysis_link_plan`.
- **`ndomo-analyses` CLI** — `list` / `get` / `search` / `archive`
  subcommands reading from the project-local `.ndomo/state.db`.
- **Integration test suite** (`tests/integration/ranger-flow.test.ts`)
  — 13 end-to-end tests covering create→link→search→archive→unlink
  flows and FK CASCADE behavior on plan deletion.
- **Hybrid JEV routing** — task delegation is now classified through
  `classifyTaskWithJev` (`src/orchestrator/jev.ts`, `@typesafe-ai/sdk`
  0.6.0) with the deterministic heuristic as fallback; `routeTask()`
  surfaces `source: "jev" | "rules"`. Activated via the optional
  `TYPESAFE_API_KEY` env var — no network access without it.

### Changed

- **10 smith agents** (`smith`, `go-smith`, `js-smith`, `python-smith`,
  `vue-smith`, `zig-smith`, `rust-smith`, `ci-smith`, `deploy-smith`,
  `release-smith`) switched to `opencode-go/mimo-v2.6-flash` in the
  default preset and agent frontmatter (`temperature: 0.1`,
  `reasoning_effort: high` unchanged).
- Biome cleanup: VCS-mode config, autofixes, and import ordering
  (no behavior change).
- Updated `docs/agents.md` from 21 agents (3 primaries) to 22 agents
  (4 primaries), including cross-primary routing table for the new
  ranger entry point.
- Routing tables in `foreman.md`, `craftsman.md`, and `warden.md`
  now list ranger alongside the existing primary peers.

### Fixed

- DB hygiene: enable WAL journal mode, NORMAL synchronous, INCREMENTAL
  auto_vacuum to prevent unbounded `.ndomo/state.db` growth on long-running
  installs. Sticky one-time migration per DB on first open after upgrade.
  New `ndomo vacuum` CLI subcommand (or `bun run src/cli/vacuum.ts`) for
  manual space reclaim via `PRAGMA incremental_vacuum` + `wal_checkpoint(TRUNCATE)`.
  WAL sidecars (`*.db-wal`, `*.db-shm`) added to `.gitignore`.
- Shutdown cleanup: `src/db/shutdown.ts` now tracks every `openDb()` call in
  a `Set<Database>` so each connection gets `SIGTERM`/`SIGINT`/`beforeExit`
  cleanup. Replaces the module-level `registered` boolean that silently
  skipped every call after the first (leaked file handles on hot-reload,
  CLI tools alongside plugin, smoke tests).
- Background task retention: `BackgroundDispatcher.finalize(maxAgeMs)` prunes
  terminal tasks (completed/failed/cancelled) older than the threshold; auto-
  called from plugin init when row count exceeds `backgroundRetention.softCap`
  (default 1000). Stops unbounded growth of `background_tasks` on long-running
  installs.
- Write-tool lock leaks: replaced raw `Map<string, string>` for active writes
  with a `FileLock` class that stamps each entry with `setAt` and prunes stale
  locks via TTL sweep. SDK hook-chain breaks (where `tool.execute.after` never
  fires) no longer block subsequent writes indefinitely. Admin tool
  `ndomo_write_unlock` exposed for manual recovery.

## [0.3.0] - 2026-06-30

### Added

- **Plan & task write stack** — full CRUD across CLI, HTTP, and Web UI:
  - **DB v16 migration** (`src/db/schema.ts` + `src/db/migrations.ts`):
    `plans.owner TEXT NOT NULL DEFAULT 'foreman'` column. CHECK constraint
    deferred to app layer (SQLite ALTER limitation). 7 v16 tests.
  - **CLI subcommands** — `ndomo plan create|list|show|update|approve|complete|delete`
    and `ndomo task create|list|show|update|reassign|complete|fail`
    (validated, register in `src/cli/index.ts`). 26 tests.
  - **HTTP write endpoints** (10 new routes):
    - Plans: `POST /api/plans`, `PUT /api/plans/:id`,
      `PATCH /api/plans/:id/status`, `POST /api/plans/:id/approve`,
      `DELETE /api/plans/:id`
    - Tasks: `POST /api/plans/:id/tasks`, `PUT /api/tasks/:id`,
      `PATCH /api/tasks/:id/status`, `PATCH /api/tasks/:id/reassign`,
      `DELETE /api/tasks/:id`
  - **Shared schemas** (`src/http/schemas.ts`) — Elysia `t` validators + plain
    TS body types reused by HTTP and CLI. No new deps (no zod).
  - **Web UI write composables** — `usePlanMutations`, `useTaskMutations`
    wrap the API with `isLoading`/`error` refs.
  - **Web UI write components** — `CreatePlanForm`, `EditPlanForm`,
    `CreateTaskForm`, `StatusActions`, `AgentReassignDropdown` (daisyUI).
  - **Smoke-web write assertions** — `scripts/smoke-web.sh` extended with
    52 lines covering POST/PUT/PATCH/DELETE round-trips.
- **`/plans/new` route** — Create Plan view reachable from PlanList header
  (`+ Create Plan` button).
- **Web UI redesigned with Bulma 1.0** (CSS-only, no jQuery, ~250KB
  minified). Status palette exposed as CSS custom properties in
  `web/src/styles/main.css`.
- `web/src/styles/main.css` — Bulma entry point + status palette CSS custom
  properties (`--status-pending`, `--status-running`, `--status-done`,
  `--status-failed`, `--status-blocked`, plus plan statuses).
- 87 web UI unit tests (api client, composables, components, write forms).
- 18 HTTP write-endpoint integration tests covering happy paths, 400/401/404/409
  error responses, and SSE event emission.

### Changed

- Web UI redesigned with **Bulma 1.0** CSS framework (CSS-only, no jQuery,
  ~250KB minified). Status palette exposed as CSS custom properties in
  `web/src/styles/main.css`.
- `src/db/plans.ts` — `createPlan` now inserts `owner` column.
- `src/db/tasks.ts` — added `createTask` (single), `updateTaskFields`,
  `deleteTask`, and `reassignTask` (fixed pre-existing `updated_at`
  reference bug).
- `src/db/types.ts` — `PlanOwner` type exported; `Plan.owner` optional with
  DB default.

### Removed

- `web/src/styles/globals.css` and `web/src/styles/tokens.css` — replaced
  by `web/src/styles/main.css`.

### Fixed

- CLI `parseArgs` treated empty string `--agent ""` as boolean true
  (both `src/cli/plan.ts` and `src/cli/task.ts`).
- `reassignTask` UPDATE referenced non-existent `updated_at` column.

## [0.1.0] - 2026-06-20

### Added

- Initial ndomo orchestrator: `routeTask`, `canRunParallel`, and reconciler
  primitives for multi-agent task dispatch and lifecycle management
- Multi-agent fleet: `foreman` and `craftsman` primaries plus 19 specialist
  subagents (scout, scribe, painter, smith, sage, guild, inspector,
  chronicler, stack-smiths, and warden ops fleet)
- OpenCode plugin layer with hooks, custom tools, hot-swap support, and
  frontmatter sync for agent and skill metadata
- DB module: SQLite-backed plans, tasks, and sessions tables with FTS5 search,
  migrations v1 through v11, and dual plan system (global state.db +
  per-project archive)
- Memory system integration with `opencode-mem` including scoped tags,
  cross-project retrieval, and project-scoped instincts to prevent
  cross-project contamination
- Worktree management under `.slim/worktrees/` for parallel, isolated coding
  lanes
- Flexible builder pipeline (v2 + v3-lows) and `craftsman` primary agent with
  plan_db audit trail and pre-merge critical fixes
- Curl-based install script with provider picker (ndomo vs stock OpenCode)
- `reasoning_effort` configuration and bundled skills directory for offline
  distribution
- `state.db` CLI with 14 tools and 5 migrations covering plan/task/session
  CRUD, FTS search, and checkpoint helpers

### Changed

- Biome-formatted source tree across all TypeScript modules
- Documentation refresh covering DB module, flexible builder primary, and
  ad-hoc flow spec

### Fixed

- Per-project plan archive: drop the global `~/.ndomo/mem/plans` default in
  favor of project-local storage
- Scoped session foreign-key upsert (Issue #1 hybrid) so session rows respect
  plan scoping rules
- DB query layer: `getPlan`, `getPlanBySlug`, and `listPlans` now JOIN with
  `plan_files` so file links ship with every plan read
- Seven medium-priority `craftsman` fixes shipped alongside the Bun skill
  bootstrap for the `js-smith` specialist

[0.8.1]: https://github.com/nicosup98/ndomo-v2/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/nicosup98/ndomo-v2/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/nicosup98/ndomo-v2/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/nicosup98/ndomo-v2/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/nicosup98/ndomo-v2/compare/v0.5.0...v0.5.1
[Unreleased]: https://github.com/nicosup98/ndomo-v2/compare/v0.8.1...HEAD
[0.3.0]: https://github.com/nicosup98/ndomo-v2/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/nicosup98/ndomo-v2/releases/tag/v0.1.0
