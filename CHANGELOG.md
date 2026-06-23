# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 (2026-06-23)


### Features

* **analyses:** v15 findings_json observation/proposedAction split ([eeefcd9](https://github.com/nicosup98/ndomo-v2/commit/eeefcd90e04a3066c043f3a2da95f24f79d49192))
* **craftsman:** apply 7 medium-priority fixes + bun skill for js-smith ([7229e47](https://github.com/nicosup98/ndomo-v2/commit/7229e47c78fb9d56d0e7dabc9e6b2064c5222f8e))
* **craftsman:** introduce primary craftsman agent with plan_db audit trail ([7f9f8f4](https://github.com/nicosup98/ndomo-v2/commit/7f9f8f4acc8b9c3f51f8a8988461cfd46f1fe0d8))
* custom tools, hot-swap, reasoning_effort, bundled skills, security ([215b01a](https://github.com/nicosup98/ndomo-v2/commit/215b01a6178850cdf4dceef017a5fca19554c46a))
* DB module, install.sh curl+provider, docs refresh ([1463736](https://github.com/nicosup98/ndomo-v2/commit/1463736d0e202e8995d57c43dd4239de33e8ccd2))
* **db:** Issue 2 - getPlan/getPlanBySlug/listPlans JOIN con plan_files ([b172675](https://github.com/nicosup98/ndomo-v2/commit/b1726753eac3e55a415ddc36359cd58db4586ab5))
* **db:** PRAGMA WAL/NORMAL/INCREMENTAL + vacuum CLI subcommand ([f5f5f19](https://github.com/nicosup98/ndomo-v2/commit/f5f5f19600ee17701d772fe10efc1aa2ae647a7d))
* **db:** t3 unified close flow + v13 ops tables + auto-checkpoint ([6bab95b](https://github.com/nicosup98/ndomo-v2/commit/6bab95bac5173db22be3dfbdea83b96ec0f04eab))
* **ops:** add release-please, commitlint/husky, CI lint+cache, Dockerfile ([44ded1f](https://github.com/nicosup98/ndomo-v2/commit/44ded1f4a9511cd05318725e7bc3a7f53de9571e))
* **orchestrator:** BackgroundDispatcher.finalize for retention sweep ([39d8e85](https://github.com/nicosup98/ndomo-v2/commit/39d8e851b325b115701943e7b7d9742ff1aadf8b))
* **release:** ranger agent + analyses module new files ([bffe69d](https://github.com/nicosup98/ndomo-v2/commit/bffe69d7bbd83d4c747d43d00b739d500d5f1561))
* **release:** ranger agent + analyses table + tools ([2bd2c20](https://github.com/nicosup98/ndomo-v2/commit/2bd2c20e231cd3e1432f2656f558d1e95c5fa64b))


### Bug Fixes

* **db:** collision-safe task batch order_index + openDb path hardening + craftsman docs ([a195b29](https://github.com/nicosup98/ndomo-v2/commit/a195b29a154e8bdd98e2fdce2c008cc799948e9b))
* **db:** shutdown.ts multi-instance cleanup with Set&lt;Database&gt; ([af42ce2](https://github.com/nicosup98/ndomo-v2/commit/af42ce2bf9b6165fe8fdd8c2b1e90e6c0c98d8e0))
* **merge:** resolve CHANGELOG.md + plugin.test.ts conflicts ([8508259](https://github.com/nicosup98/ndomo-v2/commit/85082599d9882a4e2905b8d73e1b39e9a5f5ae5b))
* per-project plan archive (drop global ~/.ndomo/mem/plans default) ([a20ea51](https://github.com/nicosup98/ndomo-v2/commit/a20ea51bf11cc0c3e7216091c55c4e0b4c2a1c14))
* **plugin:** FileLock helper + activeWrites TTL + ndomo_write_unlock ([455ca19](https://github.com/nicosup98/ndomo-v2/commit/455ca19b5c9885fe3fcde787bcdc6fb944a499fa))
* scoped session FK upsert (Fix [#1](https://github.com/nicosup98/ndomo-v2/issues/1) hybrid) + foreman Trivium-self ([d8c7c1e](https://github.com/nicosup98/ndomo-v2/commit/d8c7c1e1b4c5d527ec383a1e793408b1eeda6d68))

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
