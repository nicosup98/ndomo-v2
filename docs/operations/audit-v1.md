# ndomo Audit v1 — Operational Gap Analysis

**Date:** 2026-06-20
**Scope:** ndomo project (self-audit)
**Author:** ops-scout
**Method:** Read-only recon of repo state (no edits, no commits, no state changes)

---

## Executive Summary

ndomo is a young but unusually disciplined OpenCode plugin: strict TS (`tsconfig.json:9-22`), biome-formatted, bundled install path via `scripts/install.sh`, a single trivium-style CI workflow, conventional commits, and 3 ops-specific primary/subagents (`warden`, `ci-smith`, `deploy-smith`, `release-smith`, `ops-scout`) that already encode the discipline the repo lacks in automation. The plugin runtime itself ships a `status` health tool (`src/plugin.ts:665-680`) and uses `console.*` only with an `[ndomo]` prefix.

Operational maturity, however, is at "week 1": only one workflow exists (`.github/workflows/smoke.yml`, 20 lines), zero deploy surface beyond shell scripts, no release artifacts (no tags, no `CHANGELOG.md`, no `.github/release.yml`), no secret scanning, no Dependabot/Renovate, no CodeQL, no `Dockerfile`, no `compose.yml`, no `.dockerignore`, no `.npmignore`, no `CODEOWNERS`, no PR template, no `CONTRIBUTING.md`, no branch-protection audit possible (no `gh` auth in this environment), and `package.json:53-55` ships an empty `"repository.url": ""` placeholder. Several dependencies are outdated by major versions (`@biomejs/biome 1.9.4 → 2.5.0`, `typescript 5.9.3 → 6.0.3`).

**Top 3 critical gaps:**

1. **[MISSING-001] Zero release process** — no `CHANGELOG.md`, no semver automation, no tags, no GitHub release template, so the v0.1.0 declared in `package.json:3` is fiction from a release-engineering standpoint.
2. **[MISSING-007] No secret scanning + GitHub Actions pinned by tag not SHA** — `smoke.yml:13-14` uses `actions/checkout@v4` and `oven-sh/setup-bun@v2`; supply-chain risk combined with no `gitleaks`/`CodeQL` means a compromised action runs unverified.
3. **[MISSING-010] No Dependabot/Renovate + outdated major deps** — `npm outdated` shows 2 major-version drifts unreviewed; without automated PRs, drift will accumulate.

**Estimated remediation effort:** 8–12 person-days for the Critical + High buckets; achievable in 1 sprint by `ci-smith` + `release-smith` working against a warden-owned `ops-bootstrap-release-ci` plan.

---

## Findings by Dimension

### 1. CI/CD Coverage

**Current state:**
- **1 workflow only:** `.github/workflows/smoke.yml` (20 lines).
  - Triggers: push and PR to `main` (`.github/workflows/smoke.yml:3-7`).
  - Runner: `ubuntu-latest`, single OS, no matrix (`.github/workflows/smoke.yml:11`).
  - Steps: checkout → `oven-sh/setup-bun@v2` (latest, no version pin) → `bun install` → `bun run typecheck` → `bun test` → `bun run test:smoke` (`.github/workflows/smoke.yml:13-19`).
  - No caching (`actions/cache`, `setup-bun` cache, or `bun install` cache).
  - No artifact upload, no coverage report, no SARIF upload.
  - Secrets: none referenced (no `${{ secrets.* }}`).
- **Tooling declared but not exercised in CI:**
  - `bun run lint` (`biome check .`) and `bun run lint:fix` exist in `package.json:21-22` but are NOT in `smoke.yml` → lint regressions merge silently.
  - `bun run format` (`biome format --write .`) not in CI.
- **No Dependabot, no Renovate:** no `.github/dependabot.yml`, no `renovate.json` at root.
- **No CodeQL:** no `.github/workflows/codeql.yml`.
- **No actionlint / workflow validation:** not run locally; no pre-commit hook.

**Gaps:**
- **[MISSING-007] (Severity: Critical)** — GitHub Actions pinned by floating tags + no SHA verification.
  - Evidence: `.github/workflows/smoke.yml:13` uses `actions/checkout@v4`; line 14 uses `oven-sh/setup-bun@v2`; `bun-version: latest` (line 16) is a moving target.
  - Impact: supply-chain takeover of any of these actions executes inside `main` PRs with full repo write.
  - Recommended fix: pin each `uses:` to a 40-char commit SHA; replace `bun-version: latest` with the minimum pinned version matching `engines.bun` (`>=1.1.0` per `package.json:15`).
  - Effort: **S** (single workflow file, ≤2 hours).
- **[MISSING-008] (Severity: High)** — Lint job missing from CI; biome configured but not enforced.
  - Evidence: `package.json:21` defines `lint: biome check .`; `.github/workflows/smoke.yml:13-19` does not run it.
  - Impact: style/lint regressions land in main; `biome.json:1` configures `recommended` rules but they are advisory only.
  - Recommended fix: add `bun run lint` step before `bun test`; consider `bun run format --check`.
  - Effort: **S**.
- **[MISSING-009] (Severity: High)** — No caching layer in CI.
  - Evidence: `.github/workflows/smoke.yml:17` runs `bun install` with no `actions/cache` and no `setup-bun` cache option enabled.
  - Impact: cold runs re-resolve ~28 KB lockfile + ~77 `node_modules/` entries every job; estimated 30–60 s waste per run.
  - Recommended fix: enable built-in `setup-bun` cache (default since v1.1) or add explicit `actions/cache@v4` keyed on `bun.lock` hash.
  - Effort: **S**.
- **[MISSING-010] (Severity: Critical)** — No Dependabot / Renovate config + outdated majors unmonitored.
  - Evidence: `npm outdated` reports `@biomejs/biome 1.9.4 → 2.5.0` (major), `typescript 5.9.3 → 6.0.3` (major), `@opencode-ai/plugin 1.17.7 → 1.17.8` (minor), `opencode-mem 2.17.1 → 2.17.2` (patch). No `.github/dependabot.yml`, no `renovate.json`.
  - Impact: silent dependency drift; typecheck runs against an unsupported TS major.
  - Recommended fix: add `.github/dependabot.yml` with weekly schedule, `groups` for devDeps/prodDeps, and `labels: ["dependencies"]`.
  - Effort: **S**.
- **[MISSING-011] (Severity: Medium)** — No matrix strategy (single OS, single Bun version).
  - Evidence: `.github/workflows/smoke.yml:11` hard-codes `ubuntu-latest`; no `strategy.matrix`.
  - Impact: macOS/Windows regressions invisible; Bun version drift invisible.
  - Recommended fix: add `matrix: { os: [ubuntu-latest, macos-latest], bun: [1.1.x, latest] }` with `fail-fast: false`.
  - Effort: **S**.
- **[MISSING-012] (Severity: Low)** — No CodeQL security scan workflow.
  - Evidence: no `.github/workflows/codeql.yml`.
  - Impact: TS source not scanned for injection / unsafe-eval patterns.
  - Recommended fix: enable CodeQL via `.github/workflows/codeql.yml` on `push` + `schedule: weekly`.
  - Effort: **S**.
- **[MISSING-013] (Severity: Low)** — No coverage reporting (no `bun test --coverage` step, no Codecov).
  - Evidence: `package.json:24` runs `bun test` plain; no codecov badge in README.
  - Impact: coverage drift invisible.
  - Recommended fix: add `bun test --coverage` + `codecov/codecov-action@v4` upload (after MISSING-007 SHA pinning).
  - Effort: **S**.

---

### 2. Deploy Surface

**Current state:**
- **No container artifacts:** no `Dockerfile`, no `docker-compose.yml`, no `compose.yml`, no `compose.yaml` anywhere in repo (confirmed via `find . -maxdepth 3 -name 'Dockerfile*' -o -name 'docker-compose*'` returning empty).
- **No container ignore files:** no `.dockerignore`, no `.npmignore`.
- **No Kubernetes / serverless manifests:** no `k8s/`, no `serverless.yml`, no `terraform/`, no `helm/`.
- **Install/uninstall scripts:** `scripts/install.sh` (662 lines, single-purpose: copy `agents/`, `skills/`, `config/` into `~/.config/opencode/`), `scripts/uninstall.sh` (217 lines).
  - `install.sh` supports piped-from-URL mode (clones via `git` or downloads tarball, re-execs from `/tmp`) — see `scripts/install.sh:1-30`.
  - Flags: `--provider=ID`, `--no-provider-prompt`, `--preset=budget|default`, `--with-dcp`, `--repo=`, `--branch=`.
- **Smoke scripts:** `scripts/smoke.sh` (9 lines, wraps `src/cli/smoke.ts`), plus legacy `smoke-v4.ts`, `smoke-v5.ts`, `smoke-e2e.ts`, `smoke-hot.ts` (test harnesses, not deploy).
- **No rollback script:** no `scripts/rollback*`, no `scripts/revert*`.
- **No deploy runbook:** README and `docs/installation.md` describe install only; no `docs/deployment.md`, no `docs/operations/` directory prior to this audit.

**Gaps:**
- **[MISSING-014] (Severity: High)** — No `Dockerfile` for containerized plugin execution.
  - Evidence: `find . -maxdepth 4 -iname 'dockerfile*'` returns nothing.
  - Impact: CI users, sandbox demos, and self-hosted agent runners cannot run ndomo reproducibly; install.sh assumes macOS/Linux host with bun pre-installed.
  - Recommended fix: add a multi-stage `Dockerfile` (`oven/bun:1.1-distroless` → copy `src/`, `skills/`, `agents/`, `config/`, `package.json`, `bun.lock`; entrypoint `bun run src/index.ts`).
  - Effort: **M**.
- **[MISSING-015] (Severity: High)** — No `.dockerignore`.
  - Evidence: file absent; would currently include `.git/`, `node_modules/`, `.slim/`, `.ndomo/`, `.opencode/`, `docs/`, `*.test.ts` if created.
  - Impact: image bloat, secret leakage risk (any `.env` accidentally staged copies in).
  - Recommended fix: create `.dockerignore` referencing the same exclusions as `.gitignore:1-75`.
  - Effort: **S**.
- **[MISSING-016] (Severity: Medium)** — No rollback procedure documented or scripted.
  - Evidence: no `scripts/rollback.sh`, no `docs/deployment.md`, no `docs/rollback.md`; `warden.md` "No operación destructiva sin rollback plan" rule (line 5 of agent definition) has no backing artifact.
  - Impact: agent policy references a procedure that doesn't exist in repo.
  - Recommended fix: add `scripts/rollback.sh` + `docs/operations/rollback.md` with concrete steps for the install.sh + uninstall.sh pair.
  - Effort: **M**.
- **[MISSING-017] (Severity: Medium)** — No multi-environment deploy story (dev / staging / prod).
  - Evidence: install.sh targets `~/.config/opencode/` only; no `--env=dev|staging|prod` flag.
  - Impact: single-environment install; cannot test changes in isolation.
  - Recommended fix: add `--prefix=DIR` flag to install.sh to support parallel installations; document in `docs/operations/environments.md`.
  - Effort: **M**.
- **[MISSING-018] (Severity: Low)** — No `.npmignore` despite `"main": "./src/index.ts"` in `package.json:7`.
  - Evidence: no `.npmignore`; if published to npm, would ship `node_modules/`, `.slim/`, `.ndomo/`, `docs/`, `scripts/`, all `.test.ts` files.
  - Impact: oversized npm tarball, leaked test files and state directories.
  - Recommended fix: create `.npmignore` mirroring `.gitignore`.
  - Effort: **S**.
- **[MISSING-019] (Severity: Low)** — No package publishing workflow.
  - Evidence: no `.github/workflows/publish.yml`, no `release-it`/`changesets`/`semantic-release` config.
  - Impact: deferred — repo is `"private": true` in `package.json:13`, so publish is opt-in.
  - Recommended fix: defer until public release decision; if yes, add `changesets` (matches existing conventional-commit style).
  - Effort: **L** (deferred).

---

### 3. Release Process

**Current state:**
- **Versioning:** `"version": "0.1.0"` hardcoded in `package.json:3`. No `VERSION` file. No `git tag` exists (`git tag --list` returns empty).
- **Changelog:** no `CHANGELOG.md`. `docs/plans` is a symlink to `../.slim/plans/` containing 3 archived plans (`docs-curl-install.md`, `docs-db-module.md`, `v5-fts-hotfix.md`) — these are *plan* archives, not release notes.
- **GitHub release template:** no `.github/release.yml`.
- **Branch strategy:** trunk-based with feature branches. Evidence: `git log --all --oneline --graph` shows `feature/flexible-builder` branch merged into `main` via `c934729 Merge feature/flexible-builder...`; no `develop`, no `release/*`, no `hotfix/*` branches. 1 local branch (`main`) + 1 remote tracking.
- **Conventional commits:** actively used. Recent log: `feat(craftsman):`, `style: format code with biome`, `fix:`, `docs:`, `chore:`. No formal enforcement (no commitlint, no husky).
- **Release notes:** none. `release-smith.md` agent definition describes responsibilities (semver, CHANGELOG, `gh release create`, annotated tags) but the agent has no automation to call.
- **Repository metadata:** `"repository": { "type": "git", "url": "" }` (`package.json:53-55`) — empty URL placeholder.

**Gaps:**
- **[MISSING-001] (Severity: Critical)** — Zero release process: no CHANGELOG, no tags, no version file, no release notes.
  - Evidence: `ls CHANGELOG* VERSION*` returns nothing; `git tag --list` empty; no `.github/release.yml`.
  - Impact: "v0.1.0" in `package.json:3` is unverifiable; consumers cannot diff versions; security advisories cannot be backported.
  - Recommended fix: (a) add `CHANGELOG.md` (Keep-a-Changelog format), (b) initialize `git tag v0.1.0` for current state, (c) add `.github/release.yml` with categories (Features, Bug Fixes, Breaking Changes auto-derived from labels), (d) adopt `changesets` or `release-please` for automation.
  - Effort: **M**.
- **[MISSING-002] (Severity: High)** — No semantic-release automation despite conventional-commit usage.
  - Evidence: commit history shows conventional-commit format (`feat:`, `fix:`, `chore:`); no `.github/workflows/release.yml`, no `release-please-config.json`, no `.changeset/` directory.
  - Impact: manual version bumps will drift from commit types.
  - Recommended fix: add `release-please` (matches Google-style, free, GHA-native) or `changesets` (matches monorepo patterns).
  - Effort: **M**.
- **[MISSING-003] (Severity: High)** — No commit-message enforcement.
  - Evidence: no `.husky/commit-msg`, no `commitlint.config.js`, no `lefthook.yml`. Conventional commits used voluntarily.
  - Impact: contributor commits will diverge from convention; release-please/changesets depend on it.
  - Recommended fix: add `commitlint` + `husky` `commit-msg` hook with `@commitlint/config-conventional`.
  - Effort: **S**.
- **[MISSING-004] (Severity: Medium)** — `package.json` repository URL is empty string.
  - Evidence: `package.json:53-55` has `"repository": { "type": "git", "url": "" }`.
  - Impact: README "Links" section shows `<repo-url>` placeholder (`README.md:78`); npm publish would fail or publish to wrong repo; GitHub features (stars, fork links) broken.
  - Recommended fix: replace with `https://github.com/<org>/ndomo`.
  - Effort: **S**.
- **[MISSING-005] (Severity: Medium)** — No `.github/release.yml` for templated release notes.
  - Evidence: file absent.
  - Impact: when releases start, manual `gh release create` will produce unstructured notes.
  - Recommended fix: add release.yml with `changelog.categories` mapping PR labels to sections.
  - Effort: **S**.
- **[MISSING-006] (Severity: Low)** — No `CONTRIBUTING.md`.
  - Evidence: file absent.
  - Impact: new contributors lack commit-message, branch, and review guidance.
  - Recommended fix: write `CONTRIBUTING.md` linking to `docs/workflows.md` and the conventional-commit rule.
  - Effort: **S**.

---

### 4. Secrets Management

**Current state:**
- **`.gitignore` coverage:** strong. Lines 44-46 ignore `.env`, `.env.local`, `.env.*.local`. Lines 64, 74 ignore `.ndomo/`, `.opencode/` (state directories that may contain secrets). Lines 22-25 ignore `*.sqlite*` (opencode-mem DBs). Lines 49-53 ignore `*.log`, `logs/`.
- **No `.env*` files in repo:** confirmed via `ls -la .env*` returning empty (shell-reported "no matches").
- **Config secrets scan:** `config/ndomo.schema.json` and `config/ndomo.config.json` contain only model/provider identifiers (e.g. `xiaomi-token-plan-sgp/mimo-v2.5-pro` in `config/ndomo.config.json:109`) — no API keys, no passwords. The "token" substring is part of a provider slug, not a credential.
- **Code-level env references:** only one in `src/plugin.ts:1` (`NDOMO_SKIP_FRONTMATTER_SYNC`), used as a feature flag, not a credential.
- **No Vault/Doppler/1Password integration:** no client config, no `vault` binary reference, no `.doppler.yaml`.
- **No secret-scanning tool:** no `gitleaks` (not installed locally), no `trivy` (not installed), no GitHub Secret Scanning config (not verifiable without `gh`).
- **README example:** `README.md:43` uses `<repo-url>` placeholder (not a real URL, not a secret).

**Gaps:**
- **[MISSING-020] (Severity: Medium)** — No secret-scanning workflow.
  - Evidence: no `.github/workflows/secret-scan.yml`, no `gitleaks-action` reference.
  - Impact: committed secrets (if accidentally staged) push to remote without local detection; GitHub Secret Scanning depends on partner program enrollment.
  - Recommended fix: add `gitleaks/gitleaks-action@v2` (after SHA pinning per MISSING-007) as a pre-PR step.
  - Effort: **S**.
- **[MISSING-021] (Severity: Low)** — No documented secret rotation policy.
  - Evidence: no `docs/security.md`, no `docs/operations/secrets.md`.
  - Impact: future contributors won't know rotation cadence or incident response.
  - Recommended fix: document when model-provider tokens rotate and where they live (`~/.config/opencode/` provider config).
  - Effort: **S**.
- **[MISSING-022] (Severity: Low)** — `process.env.NDOMO_SKIP_FRONTMATTER_SYNC` not documented.
  - Evidence: `src/plugin.ts:1` references it but no doc lists supported env vars.
  - Impact: feature flag is invisible to operators.
  - Recommended fix: add `docs/operations/environment-variables.md`.
  - Effort: **S**.

---

### 5. Monitoring

**Current state:**
- **Logging:** `console.log` / `console.warn` only, with `[ndomo]` prefix. 12 lines in `src/plugin.ts` (lines 226, 233, 238, 273, 279, 286, 292, 339, 345, 364, 438, 525). No structured logger (pino, winston), no log levels, no JSON output.
- **Health check:** `status` tool exposed via plugin runtime (`src/plugin.ts:665-680`); returns JSON `{ plugin, version, directory, worktree, activeTasks, activeWrites, preset }`. CLI counterpart: `bin/ndomo-status.ts` → `src/cli/status.ts:1-50+`. Also `npm run status:plans` (`package.json:26`).
- **Metrics:** none. No Prometheus exporter, no OpenTelemetry, no custom counters.
- **Error tracking:** no Sentry, no Rollbar, no Bugsnag.
- **Alerting:** none.
- **Plugin shutdown:** `registerShutdownHandlers` imported in `src/plugin.ts:39` — graceful shutdown logic present.

**Gaps:**
- **[MISSING-023] (Severity: Medium)** — No structured logging.
  - Evidence: `src/plugin.ts:226` uses `console.warn` with template literals; no log level, no JSON, no timestamp, no correlation ID.
  - Impact: log aggregation impossible; debugging across distributed runs requires grep.
  - Recommended fix: introduce a thin logger wrapper (`src/lib/logger.ts`) emitting JSON to stdout when `NDOMO_LOG=json`, with `level` filter.
  - Effort: **M**.
- **[MISSING-024] (Severity: Medium)** — Health tool not exposed as HTTP endpoint.
  - Evidence: `src/plugin.ts:665-680` defines the tool as an OpenCode plugin tool (not an HTTP server). Plugin lifecycle is in-process; no `http.createServer`.
  - Impact: external monitors (Kubernetes liveness probe, uptime checkers) cannot query ndomo health.
  - Recommended fix: if ndomo ever ships as a long-running daemon, expose `/health` and `/ready` on a configurable port; for now, document the `status` tool as the canonical probe.
  - Effort: **L** (architectural).
- **[MISSING-025] (Severity: Low)** — No error tracking integration.
  - Evidence: no `Sentry.init`, no error reporter.
  - Impact: production failures invisible; no stack aggregation.
  - Recommended fix: defer until hosted product exists; for now, ensure `console.error` path is exercised for uncaught throws.
  - Effort: **L** (deferred).
- **[MISSING-026] (Severity: Low)** — No operational dashboards.
  - Evidence: no Grafana config, no Datadog config, no `docs/operations/dashboards.md`.
  - Impact: ops state invisible to humans.
  - Recommended fix: when MISSING-023 lands, define 3 starter metrics: `ndomo_active_tasks`, `ndomo_db_size_bytes`, `ndomo_plan_status_total{status}`.
  - Effort: **M** (after logger exists).

---

### 6. Security

**Current state:**
- **Dependency audit:** `npm audit` fails with `ENOLOCK` because the project uses `bun.lock`, not `package-lock.json`. The bun equivalent `bun audit` was not run (out of read-only scope to install tooling).
- **Outdated dependencies** (`npm outdated` output):
  - `@biomejs/biome` 1.9.4 → 2.5.0 (**major**).
  - `typescript` 5.9.3 → 6.0.3 (**major**).
  - `@opencode-ai/plugin` 1.17.7 → 1.17.8 (minor).
  - `opencode-mem` 2.17.1 → 2.17.2 (patch).
- **TypeScript strictness:** strong. `tsconfig.json:13-22` enables `strict`, `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Biome lint rules:** `noUnusedVariables`, `useImportExtensions`, `noNonNullAssertion` (warn), `useConst`, `useTemplate`, `noExplicitAny` (warn), `noBannedTypes` (`biome.json:21-39`).
- **GitHub Actions SHA pinning:** **absent** — see MISSING-007.
- **Container base images:** n/a (no Dockerfile).
- **Secret scanning:** n/a (no workflow, no pre-commit).
- **Branch protection:** cannot verify (`gh` not installed in this env, no auth).
- **PR/Issue templates:** none.
- **CODEOWNERS:** none.

**Gaps:**
- **[MISSING-007]** (cross-ref from §1) — Actions pinned by tag, not SHA.
- **[MISSING-027] (Severity: High)** — No branch protection rules verifiable.
  - Evidence: `gh` CLI not authenticated; `git remote -v` returns `https://github.com/nicosup98/ndomo-v2.git`; protection state requires GitHub UI or `gh api`.
  - Impact: without verified rules, any contributor can push to `main`, skip reviews, force-push, or delete branches.
  - Recommended fix: enable via GitHub Settings → Branches → `main`: require PR + 1 approval, require CI pass, no force-push, no deletion.
  - Effort: **S** (UI task).
- **[MISSING-028] (Severity: Medium)** — `npm audit` non-functional due to lockfile mismatch.
  - Evidence: `npm audit --json` returns `{"error": {"code": "ENOLOCK", ...}}`. Project uses `bun.lock` (line 1 of `bun.lock`).
  - Impact: dependency CVE scanning not run via standard tooling.
  - Recommended fix: use `bun audit` in CI; add it as a job step in `smoke.yml` after lint step.
  - Effort: **S**.
- **[MISSING-029] (Severity: Medium)** — Two major-version drifts unreviewed.
  - Evidence: `@biomejs/biome 1.9.4 → 2.5.0` and `typescript 5.9.3 → 6.0.3` per `npm outdated`.
  - Impact: skipped-major upgrades likely include security fixes (e.g. Biome 2.x changed default formatter rules).
  - Recommended fix: schedule 1 PR per major, gated by typecheck + full test + smoke.
  - Effort: **M**.
- **[MISSING-030] (Severity: Medium)** — No CODEOWNERS.
  - Evidence: no `.github/CODEOWNERS`, no `CODEOWNERS`.
  - Impact: PR review assignment is manual; ops files (`.github/workflows/*`, `scripts/*`) get reviewed by whoever is awake.
  - Recommended fix: add `.github/CODEOWNERS` mapping `/.github/ @ops-team`, `/scripts/ @ops-team`, `/src/ @craftsman-team`, `/.slim/ @warden`.
  - Effort: **S**.
- **[MISSING-031] (Severity: Low)** — No PR template.
  - Evidence: no `.github/pull_request_template.md`.
  - Impact: PRs ship without checklist (typecheck run? tests added? changelog entry? breaking change?).
  - Recommended fix: add template enforcing: scope, test evidence, changelog label, breaking-change callout.
  - Effort: **S**.
- **[MISSING-032] (Severity: Low)** — No issue templates.
  - Evidence: no `.github/ISSUE_TEMPLATE/`.
  - Impact: bug reports arrive unstructured; triage cost high.
  - Recommended fix: add `bug_report.yml` and `feature_request.yml` (GitHub Forms format).
  - Effort: **S**.

---

### 7. Branch Hygiene

**Current state:**
- **Local branches:** 1 (`main`).
- **Remote branches:** 1 (`origin/main`).
- **Worktrees:** `.slim/worktrees/` exists but is empty. `git worktree list` returns only the main checkout.
- **Tags:** 0 (`git tag --list` empty).
- **Open PRs:** unverifiable (no `gh` auth).
- **Stale branches:** n/a (only 1 branch exists).
- **Merge conflicts:** n/a (no open PRs).
- **Recent graph:** `c934729 Merge feature/flexible-builder: introduce primary craftsman agent with plan_db audit trail (v6+v7+v8+v9 migrations + pre-merge critical fixes)` — feature branch merged to main, branch deleted. Clean trunk-based pattern.
- **Staged changes (working tree):**
  - New: `.github/workflows/smoke.yml`, `bin/ndomo-status.ts`, `docs/features/feature-flexible-builder-v2.md`, `opencode.json`, `scripts/smoke.sh`, `src/cli/smoke.ts`, `src/cli/status.test.ts`, `src/cli/status.ts`.
  - Modified: `package.json`, `src/db/client.ts`, `src/db/migrations-v8.test.ts`, `src/db/plan-files.test.ts`, `src/db/schema.ts`, `src/orchestrator/background.test.ts`, `src/orchestrator/background.ts`, `src/plugin.ts`.
  - Modified unstaged: `README.es.md`, `README.md`, `agents/craftsman.md`, `config/ndomo.config.json`, `docs/agents.md`, `opencode.json`.
  - **Untracked:** `agents/ci-smith.md`, `agents/deploy-smith.md`, `agents/ops-scout.md`, `agents/release-smith.md`, `agents/warden.md` — the 5 new ops agents that triggered this audit are **NOT yet committed**.
- **Plan archive:** `docs/plans → ../.slim/plans/` (symlink); contains 3 archived plans (`docs-curl-install.md`, `docs-db-module.md`, `v5-fts-hotfix.md`). Active plans in `.ndomo/state.db`.

**Gaps:**
- **[MISSING-033] (Severity: High)** — 5 ops agent files untracked + large staged changeset ready to merge.
  - Evidence: `git status` shows `?? agents/{ci-smith,deploy-smith,ops-scout,release-smith,warden}.md` and a 17-file staged changeset (2,535 insertions, 413 deletions per `git diff --cached --stat`).
  - Impact: the operational capability (warden + specialists) this audit is reporting against is sitting in the working tree, not in a tagged commit; if main moves, merge conflicts guaranteed.
  - Recommended fix: open PR immediately titled "feat(agents): introduce warden + ci-smith + deploy-smith + release-smith + ops-scout"; land before any other ops PRs.
  - Effort: **S**.
- **[MISSING-034] (Severity: Medium)** — Branch protection not verified.
  - Evidence: see MISSING-027; without protection, the 17-file changeset can be force-pushed.
  - Recommended fix: same as MISSING-027.
  - Effort: **S**.
- **[MISSING-035] (Severity: Low)** — `.slim/worktrees/` is empty but gitignored.
  - Evidence: `ls .slim/worktrees/` returns empty directory; `.gitignore:17` ignores `.slim/`. `git worktree list` shows only `/home/nico/ndomo 7229e47 [main]`.
  - Impact: none operationally; this is the expected idle state for `warden.md`'s worktree pattern. No action needed; document in `docs/operations/worktrees.md` that worktrees are opt-in per high-risk task.
  - Effort: **S**.

---

## Prioritized Roadmap

### Critical (this week)
1. **[MISSING-001]** — Establish release process (CHANGELOG.md, initial `v0.1.0` tag, `.github/release.yml`) — Effort: **M** — Depends on: MISSING-002, MISSING-003.
2. **[MISSING-007]** — Pin every `uses:` in `.github/workflows/smoke.yml` to 40-char SHA; remove `bun-version: latest` — Effort: **S** — Depends on: none.
3. **[MISSING-010]** — Add `.github/dependabot.yml` with weekly schedule and `dependencies` label — Effort: **S** — Depends on: none.
4. **[MISSING-033]** — Land untracked ops agents + 17-file changeset via a single PR before further ops work — Effort: **S** — Depends on: MISSING-007 (so PR CI runs on pinned actions), MISSING-027 (so merge requires review).

### High (next 2 weeks)
5. **[MISSING-002]** — Adopt `release-please` (or `changesets`) for automated version bumps — Effort: **M** — Depends on: MISSING-001, MISSING-003.
6. **[MISSING-008]** — Add `bun run lint` step to `smoke.yml` — Effort: **S** — Depends on: MISSING-007.
7. **[MISSING-009]** — Enable `setup-bun` cache or add `actions/cache` keyed on `bun.lock` — Effort: **S** — Depends on: MISSING-007.
8. **[MISSING-014]** — Author a multi-stage `Dockerfile` (oven/bun:1.1) — Effort: **M** — Depends on: MISSING-015.
9. **[MISSING-015]** — Author `.dockerignore` mirroring `.gitignore` — Effort: **S** — Depends on: none.
10. **[MISSING-027]** — Verify and enable GitHub branch protection on `main` (require PR, 1 review, status checks, no force-push, no delete) — Effort: **S** — Depends on: GitHub UI access.
11. **[MISSING-028]** — Add `bun audit` job to `smoke.yml` — Effort: **S** — Depends on: MISSING-007.
12. **[MISSING-029]** — Upgrade `@biomejs/biome` and `typescript` to latest majors, gated by CI — Effort: **M** — Depends on: MISSING-007.

### Medium (next month)
13. **[MISSING-003]** — Add `commitlint` + `husky` `commit-msg` hook — Effort: **S** — Depends on: none.
14. **[MISSING-004]** — Fill `package.json:55` repository URL with actual repo — Effort: **S** — Depends on: none.
15. **[MISSING-005]** — Add `.github/release.yml` with label-to-section mapping — Effort: **S** — Depends on: MISSING-001.
16. **[MISSING-011]** — Add `matrix: { os, bun }` to `smoke.yml` — Effort: **S** — Depends on: MISSING-007, MISSING-009.
17. **[MISSING-016]** — Author `scripts/rollback.sh` + `docs/operations/rollback.md` — Effort: **M** — Depends on: none.
18. **[MISSING-017]** — Add `--prefix=DIR` flag to `scripts/install.sh` for multi-environment installs — Effort: **M** — Depends on: none.
19. **[MISSING-020]** — Add `gitleaks/gitleaks-action` workflow — Effort: **S** — Depends on: MISSING-007.
20. **[MISSING-023]** — Introduce structured JSON logger with `NDOMO_LOG=json` toggle — Effort: **M** — Depends on: none.
21. **[MISSING-024]** — Document the `status` tool as the canonical health probe (defer HTTP endpoint) — Effort: **S** — Depends on: none.
22. **[MISSING-030]** — Add `.github/CODEOWNERS` mapping ops paths to ops team — Effort: **S** — Depends on: none.
23. **[MISSING-034]** — Cross-reference for MISSING-027 protection; covers the 17-file pending merge — Effort: **S** — Depends on: MISSING-027.

### Low (backlog)
24. **[MISSING-006]** — Author `CONTRIBUTING.md` — Effort: **S**.
25. **[MISSING-012]** — Enable CodeQL — Effort: **S** — Depends on: MISSING-007.
26. **[MISSING-013]** — Add `bun test --coverage` + Codecov upload — Effort: **S** — Depends on: MISSING-007.
27. **[MISSING-018]** — Add `.npmignore` (deferred until npm publish decision) — Effort: **S**.
28. **[MISSING-019]** — Adopt `changesets` if npm publishing is approved — Effort: **L** (deferred).
29. **[MISSING-021]** — Document secret rotation policy — Effort: **S**.
30. **[MISSING-022]** — Document supported env vars (`NDOMO_SKIP_FRONTMATTER_SYNC`, future `NDOMO_LOG`) — Effort: **S**.
31. **[MISSING-025]** — Add error tracking (Sentry) when hosted product exists — Effort: **L** (deferred).
32. **[MISSING-026]** — Define starter metrics dashboards — Effort: **M** — Depends on: MISSING-023.
33. **[MISSING-031]** — Add PR template — Effort: **S**.
34. **[MISSING-032]** — Add issue templates (`bug_report.yml`, `feature_request.yml`) — Effort: **S**.
35. **[MISSING-035]** — Document `.slim/worktrees/` opt-in pattern — Effort: **S**.

---

## Evidence Index

| ID | File | Lines | Snippet |
|---|---|---|---|
| MISSING-001 | `.git/refs/tags` (empty), `package.json` | 3 | `"version": "0.1.0"` with no tag, no CHANGELOG |
| MISSING-002 | `.github/workflows/` | — | No `release.yml`; no `release-please-config.json`; no `.changeset/` |
| MISSING-003 | repo root | — | No `.husky/`, no `commitlint.config.*`, no `lefthook.yml` |
| MISSING-004 | `package.json` | 53-55 | `"repository": { "type": "git", "url": "" }` |
| MISSING-005 | `.github/` | — | No `release.yml` |
| MISSING-006 | repo root | — | No `CONTRIBUTING.md` |
| MISSING-007 | `.github/workflows/smoke.yml` | 13-16 | `actions/checkout@v4`, `oven-sh/setup-bun@v2`, `bun-version: latest` |
| MISSING-008 | `.github/workflows/smoke.yml` | 13-19 | Lint not in step list despite `package.json:21` |
| MISSING-009 | `.github/workflows/smoke.yml` | 17 | `bun install` without cache key |
| MISSING-010 | `npm outdated` output | — | biome 1.9.4→2.5.0, ts 5.9.3→6.0.3, opencode-mem +opencode plugin patch |
| MISSING-011 | `.github/workflows/smoke.yml` | 11 | Single `ubuntu-latest`, no matrix |
| MISSING-012 | `.github/workflows/` | — | No `codeql.yml` |
| MISSING-013 | `.github/workflows/smoke.yml`, `package.json` | 17, 24 | `bun test` plain, no coverage flag |
| MISSING-014 | repo root | — | No `Dockerfile*` |
| MISSING-015 | repo root | — | No `.dockerignore` |
| MISSING-016 | repo root, `warden.md` | — | No `scripts/rollback.sh` despite agent rule |
| MISSING-017 | `scripts/install.sh` | 50+ | No `--prefix=DIR` flag |
| MISSING-018 | repo root | — | No `.npmignore` |
| MISSING-019 | `.github/workflows/` | — | No `publish.yml` |
| MISSING-020 | `.github/workflows/` | — | No `secret-scan.yml` |
| MISSING-021 | `docs/` | — | No `docs/security.md` or `docs/operations/secrets.md` |
| MISSING-022 | `src/plugin.ts` | 1 | `process.env.NDOMO_SKIP_FRONTMATTER_SYNC` undocumented |
| MISSING-023 | `src/plugin.ts` | 226, 233, 238, 273, 279, 286, 292, 339, 345, 364 | 12× `console.*` calls, no structured logger |
| MISSING-024 | `src/plugin.ts` | 665-680 | `status` tool is in-process only; no HTTP server |
| MISSING-025 | repo root | — | No Sentry/Bugsnag/Rollbar client |
| MISSING-026 | repo root | — | No Grafana/Datadog config |
| MISSING-027 | `.git/config`, `gh` | — | `gh` not authenticated; protection state unverifiable |
| MISSING-028 | `npm audit` output | — | `ENOLOCK` (uses `bun.lock`, not `package-lock.json`) |
| MISSING-029 | `npm outdated` | — | biome +2 major, ts +1 major |
| MISSING-030 | `.github/` | — | No `CODEOWNERS` |
| MISSING-031 | `.github/` | — | No `pull_request_template.md` |
| MISSING-032 | `.github/` | — | No `ISSUE_TEMPLATE/` |
| MISSING-033 | `git status` | — | 5 ops agents untracked + 17-file staged changeset (2,535/413) |
| MISSING-034 | — | — | Cross-ref MISSING-027 |
| MISSING-035 | `.slim/worktrees/` | — | Empty; `.gitignore:17` ignores `.slim/` |

---

**End of audit v1.** Next: open the warden-owned plan `ops-bootstrap-release-ci` covering MISSING-001, -002, -003, -007, -010 in dependency order; land MISSING-033 PR first to unblock the rest.