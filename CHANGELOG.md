# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

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

### Changed

- Web UI redesigned with **Bulma 1.0** CSS framework (CSS-only, no jQuery,
  ~250KB minified). Status palette exposed as CSS custom properties in
  `web/src/styles/main.css`.

### Added

- `web/src/styles/main.css` — Bulma entry point + status palette CSS custom
  properties (`--status-pending`, `--status-running`, `--status-done`,
  `--status-failed`, `--status-blocked`, plus plan statuses).
- 53 unit tests for web UI (including `StatusBadge` regression test).

### Removed

- `web/src/styles/globals.css` and `web/src/styles/tokens.css` — replaced
  by `web/src/styles/main.css`.

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

[Unreleased]: https://github.com/nicosup98/ndomo-v2/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nicosup98/ndomo-v2/releases/tag/v0.1.0