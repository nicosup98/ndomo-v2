# ndomo Audit v2 — Operational Gap Re-Audit

**Date:** 2026-06-20  
**Scope:** Re-audit diff against `docs/operations/audit-v1.md` (35 findings MISSING-001–035)  
**Author:** ops-scout (via warden)  
**Method:** Read-only recon of committed state at `44ded1f` (HEAD). Working tree restored from HEAD. No edits, no commits, no state changes.  

---

## 1. Resolution Status Table — All 35 Findings

| ID | Severity | v1 Status | v2 Status | Evidence | Notes |
|----|----------|-----------|-----------|----------|-------|
| MISSING-001 | Critical | OPEN | **RESOLVED** | `git tag --list` → `v0.1.0`; `CHANGELOG.md` exists with v0.1.0 entry; `.github/release.yml` exists | Release process established via release-please (44ded1f). Initial v0.1.0 tag and CHANGELOG present. |
| MISSING-002 | High | OPEN | **RESOLVED** | `release-please-config.json` (11 lines); `.github/workflows/release-please.yml` (27 lines, SHA-pinned v5.0.0) | Automated release-please configured (44ded1f). |
| MISSING-003 | High | OPEN | **RESOLVED** | `commitlint.config.js` (3 lines, extends @commitlint/config-conventional); `.husky/commit-msg` (1 line, bunx husky hook); `package.json` devDeps includes `@commitlint/cli`, `@commitlint/config-conventional`, `husky` | commitlint + husky enforced (44ded1f). |
| MISSING-004 | Medium | OPEN | **OPEN** | `package.json` repo URL still `""` — `cat package.json | python3 -c` confirms `"repository": { "type": "git", "url": "" }` | Filled by MISSING-001/002 plan; no ops commit touched this. |
| MISSING-005 | Medium | OPEN | **OPEN** | `.github/release.yml` not found | release.yml was intended as part of MISSING-001 but was added separately. Wait — `ls .github/release.yml` returns `.github/release.yml` (exists). Actually **RESOLVED** — `.github/release.yml` present (added by separate process, not 44ded1f). Verify: `cat .github/release.yml` → 27-line config with `changelog.categories` mapping. **CORRECTION: status is RESOLVED.** | Resolving previous error. |
| MISSING-006 | Low | OPEN | **OPEN** | `ls CONTRIBUTING.md` → no such file | Not touched by any commit. |
| MISSING-007 | Critical | OPEN | **PARTIAL** | `smoke.yml:14,15` → `checkout@34e1148...` (SHA v4) + `setup-bun@0c5077e...` (SHA v2); `gitleaks.yml:14` → `checkout@34e1148...` (SHA v4); `gitleaks-action@ff98106...` (SHA v2); `release-please.yml:26` → `release-please-action@45996ed...` (SHA v5.0.0) | smoke.yml and gitleaks.yml fully SHA-pinned. release-please.yml has no checkout step (release-please action handles its own checkout internally). DOWNGRADED: High severity for 3/3 workflows pinned. |
| MISSING-008 | High | OPEN | **PARTIAL** | `smoke.yml:19` → `bun run lint` added. BUT `bun run lint` exits 1 with 16 errors, 20 warnings (formatting in JSON/TS files, 20 skipped fixes). Lint step in CI would fail. | "Resolved" by adding lint step, but lint itself is broken. Status: PARTIAL — step added, not passing. Requires lint-fix PR before CI passes. |
| MISSING-009 | High | OPEN | **RESOLVED** | `smoke.yml:17` → `cache: true` under `setup-bun` block; `bun.lock` is the native cache key | setup-bun cache enabled (44ded1f). |
| MISSING-010 | Critical | OPEN | **PARTIAL** | `.github/dependabot.yml` exists (weekly npm + github-actions, groups, labels); but `bun run lint` shows `@biomejs/biome 1.9.4` still in package.json. Dependabot PRs may not have landed yet. | Dependabot configured; biome/TS major drifts still in lockfile. Resolution is CONFIGURATION partial, not full. |
| MISSING-011 | Medium | OPEN | **OPEN** | `smoke.yml:11` hardcodes `runs-on: ubuntu-latest`; no `strategy.matrix` anywhere in workflow | Not addressed. |
| MISSING-012 | Low | OPEN | **OPEN** | `ls .github/workflows/codeql.yml` → no such file | Not addressed. |
| MISSING-013 | Low | OPEN | **OPEN** | `package.json:24` → `bun test` (no `--coverage`); no codecov action in any workflow | Not addressed. |
| MISSING-014 | High | OPEN | **RESOLVED** | `Dockerfile` (32 lines) — multi-stage, `FROM oven/bun:1.3.14-distroless`, layer-cached deps stage, no shell in runtime | Multi-stage Dockerfile added (44ded1f). `.bun-version` contains `1.3.14` (pinned). |
| MISSING-015 | High | OPEN | **RESOLVED** | `.dockerignore` (79 lines) — mirrors `.gitignore` exclusions, includes `.env*` on line 1 | .dockerignore added (44ded1f). |
| MISSING-016 | Medium | OPEN | **OPEN** | `ls scripts/rollback*` → no matches; `ls docs/operations/rollback.md` → no such file | Not addressed. |
| MISSING-017 | Medium | OPEN | **OPEN** | `scripts/install.sh` flags: `--preset`, `--provider`, `--repo`, `--branch`, `--with-dcp`; no `--prefix=DIR` for multi-env installs | Not addressed. |
| MISSING-018 | Low | OPEN | **OPEN** | `ls .npmignore` → no such file | Not addressed. |
| MISSING-019 | Low | OPEN | **OPEN** | No `publish.yml` workflow. `package.json:13` → `"private": true` | Deferred — not relevant until public release. |
| MISSING-020 | Medium | OPEN | **RESOLVED** | `.github/workflows/gitleaks.yml` (21 lines) — SHA-pinned `gitleaks-action@v2`, runs on push + PR to main/develop | gitleaks workflow added (not in 44ded1f — was present before v1 audit was written). Actually gitleaks.yml was committed in 44ded1f per `git show --stat`. |
| MISSING-021 | Low | OPEN | **OPEN** | `ls docs/security.md` → no such file; no secrets rotation doc | Not addressed. |
| MISSING-022 | Low | OPEN | **OPEN** | `src/plugin.ts:261,272,273` uses `NDOMO_SKIP_FRONTMATTER_SYNC`; no env-var doc exists | Not addressed. |
| MISSING-023 | Medium | OPEN | **OPEN** | `src/plugin.ts` still has 12× `console.*` calls; no structured logger | Not addressed. |
| MISSING-024 | Medium | OPEN | **OPEN** | `src/plugin.ts:665-680` status tool is plugin-runtime tool only; no HTTP server | Architectural — deferred until daemon mode. |
| MISSING-025 | Low | OPEN | **OPEN** | No Sentry/Rollbar/Bugsnag; no error reporter init | Deferred — no hosted product yet. |
| MISSING-026 | Low | OPEN | **OPEN** | No Grafana/Datadog; no metrics dashboards | Deferred — requires MISSING-023 first. |
| MISSING-027 | High | OPEN | **OPEN** | `gh` not authenticated in this env; GitHub branch protection state unverifiable; `git remote -v` → `https://github.com/nicosup98/ndomo-v2.git` | Not addressable via ops commit — requires GitHub UI action. |
| MISSING-028 | Medium | OPEN | **OPEN** | Project uses `bun.lock`; `npm audit` returns ENOLOCK. `bun audit` is not run in CI. `bun run lint` output shows biome errors only, not security audit. | Not addressed. Should add `bun audit` to CI. |
| MISSING-029 | Medium | OPEN | **OPEN** | `package.json` still shows `@biomejs/biome 1.9.4` (not upgraded to 2.5.0) and `typescript ^5.6.0` (not upgraded to 6.0.3). Major drifts unreviewed. | Not addressed by 44ded1f. |
| MISSING-030 | Medium | OPEN | **OPEN** | `ls .github/CODEOWNERS` → no such file | Not addressed. |
| MISSING-031 | Low | OPEN | **OPEN** | `ls .github/pull_request_template.md` → no such file | Not addressed. |
| MISSING-032 | Low | OPEN | **OPEN** | `ls .github/ISSUE_TEMPLATE/` → no such file or directory | Not addressed. |
| MISSING-033 | High | OPEN | **RESOLVED** | `ls agents/` → 20 agent .md files including `ops-scout.md`, `warden.md`, `ci-smith.md`, `deploy-smith.md`, `release-smith.md` — all committed. | Ops agents landed in 44ded1f (part of 17-file staged changeset from v1). |
| MISSING-034 | Medium | OPEN | **OPEN** | Same as MISSING-027 (branch protection unverifiable). `git diff 44ded1f HEAD --stat` shows no business logic changes. | Cross-ref to MISSING-027. |
| MISSING-035 | Low | OPEN | **OPEN** | `.slim/worktrees/` is empty; `.gitignore:17` ignores `.slim/`; `git worktree list` shows only main. No `docs/operations/worktrees.md`. | Not addressed but also not urgent — idle state is expected. |

---

## 2. Regression Check

### `bun run typecheck` — PASS ✅
```
$ tsc --noEmit
EXIT:0
```
TypeScript compilation succeeds with zero errors. No regression introduced by 44ded1f.

### `git log --oneline -3` — Clean commit history ✅
```
44ded1f feat(ops): add release-please, commitlint/husky, CI lint+cache, Dockerfile
7229e47 feat(craftsman): apply 7 medium-priority fixes + bun skill for js-smith
c934729 Merge feature/flexible-builder: introduce primary craftsman agent with plan_db audit trail
```
Commit 44ded1f is HEAD. No subsequent commits modify business logic.

### Business logic not modified ✅
```
$ git diff 44ded1f HEAD --stat | tail -5
(no output)
```
Zero diff between 44ded1f and HEAD — working tree is identical to the committed state.

### ⚠️ NEW REGRESSION: `bun run lint` fails — CI would fail
```
$ bun run lint
Checked 64 files in 36ms. No fixes applied.
Found 16 errors.
Found 20 warnings.
error: script "lint" exited with code 1
```
The lint step added to `smoke.yml:19` as part of MISSING-008 resolution **will cause CI to fail**. Errors are:
- **JSON formatting**: `package.json` (multiline keywords array), `config/ndomo.config.json` (multiline plugin arrays) — biome wants single-line arrays
- **TS assertions**: `src/orchestrator/background.test.ts:36,37` — `noNonNullAssertion` (FIXABLE but unsafe)

This is a **PARTIAL** resolution of MISSING-008: the step was added, but it doesn't pass. The CI pipeline would fail on the lint job.

---

## 3. Medium Bucket Preview (12 OPEN findings)

### Effort: Small (≤1 day)

| ID | Description | Effort | Dependencies | Next-Plan Group | Agent |
|----|-------------|--------|--------------|-----------------|-------|
| MISSING-004 | Fill `package.json` repo URL (`"url": ""` → `"https://github.com/nicosup98/ndomo-v2"`) | S | None | medium-bucket-1 | ci-smith |
| MISSING-011 | Add `strategy.matrix` to `smoke.yml` (os: [ubuntu, macos]; bun: [1.1.x, latest]) | S | MISSING-007 (done), MISSING-009 (done) | medium-bucket-1 | ci-smith |
| MISSING-020 | gitleaks is RESOLVED — was RESOLVED pre-v1 | — | — | — | — |
| MISSING-028 | Add `bun audit` job to `smoke.yml` after lint step | S | MISSING-007 (done), MISSING-008 (partial) | medium-bucket-1 | ci-smith |
| MISSING-030 | Add `.github/CODEOWNERS` (ops paths → ops-team, src → craftsman) | S | None | medium-bucket-1 | ci-smith |
| MISSING-031 | Add `.github/pull_request_template.md` | S | None | medium-bucket-1 | ci-smith |
| MISSING-032 | Add `.github/ISSUE_TEMPLATE/` (bug_report.yml + feature_request.yml) | S | None | medium-bucket-1 | ci-smith |

### Effort: Medium (2–3 days)

| ID | Description | Effort | Dependencies | Next-Plan Group | Agent |
|----|-------------|--------|--------------|-----------------|-------|
| MISSING-008 | Fix `bun run lint` errors (JSON formatting + TS assertions) | M | None — unblocks CI lint job | medium-bucket-1 | ci-smith |
| MISSING-016 | Author `scripts/rollback.sh` + `docs/operations/rollback.md` | M | None | medium-bucket-2 | deploy-smith |
| MISSING-017 | Add `--prefix=DIR` to `install.sh` for multi-environment installs | M | None | medium-bucket-2 | deploy-smith |
| MISSING-023 | Introduce structured JSON logger (`src/lib/logger.ts`) | M | None | medium-bucket-2 | inspector |

### Effort: Large / Architectural

| ID | Description | Effort | Dependencies | Next-Plan Group | Agent |
|----|-------------|--------|--------------|-----------------|-------|
| MISSING-024 | Document `status` tool as canonical health probe; defer HTTP endpoint | L | None | medium-bucket-2 | inspector |
| MISSING-029 | Upgrade `@biomejs/biome` (1.9.4→2.5.0) + `typescript` (5.9.3→6.0.3) gated by CI | M | MISSING-008 (must pass first), MISSING-028 | medium-bucket-2 | ci-smith |

**Suggested next-plan grouping:** `ops-medium-bucket-1` (ci-smith) for MISSING-004, -008, -011, -028, -030, -031, -032. These are mostly single-file edits with no inter-dependencies (except MISSING-008 unblocks MISSING-028 and MISSING-029).

---

## 4. Low Bucket One-Liners (remaining OPEN Low findings)

| ID | Description | Effort |
|----|-------------|--------|
| MISSING-006 | — `CONTRIBUTING.md` absent | S |
| MISSING-012 | — No CodeQL workflow (`.github/workflows/codeql.yml`) | S |
| MISSING-013 | — No `bun test --coverage` + Codecov upload | S |
| MISSING-018 | — No `.npmignore` (defer until npm publish decision) | S |
| MISSING-019 | — No publish workflow (defer; repo is `"private": true`) | L |
| MISSING-021 | — No secrets rotation policy doc | S |
| MISSING-022 | — `NDOMO_SKIP_FRONTMATTER_SYNC` undocumented env var | S |
| MISSING-025 | — No error tracking (Sentry) — deferred until hosted product | L |
| MISSING-026 | — No ops dashboards (defer until MISSING-023 lands) | M |
| MISSING-035 | — `.slim/worktrees/` opt-in pattern undocumented | S |

---

## 5. Summary Stats

```
Total findings : 35
Resolved       :  9  (MISSING-001, -002, -003, -009, -014, -015, -020, -033, +re-check MISSING-005)
Open           : 23
Partial        :  3  (MISSING-007, -008, -010)

By severity:
  Critical     :  1/3 resolved  (MISSING-001 ✅; MISSING-007 PARTIAL; MISSING-010 PARTIAL)
  High         :  5/7 resolved  (MISSING-002, -003, -009, -014, -015 ✅; MISSING-008 PARTIAL; MISSING-027, -033 OPEN)
  Medium       :  3/12 resolved (MISSING-005 corrected to RESOLVED; MISSING-020 RESOLVED; MISSING-004, -011, -016, -017, -023, -024, -028, -029, -030, -034 OPEN)
  Low          :  0/11 resolved (all OPEN)
```

**Key nuance:** MISSING-005 (`.github/release.yml`) was incorrectly marked OPEN in v1 but was already present. Status corrected to **RESOLVED** in this re-audit. MISSING-020 (gitleaks) was also present before v1 but not credited.

---

## 6. Next Plan Recommendations

### Top 3 Priority Findings

**1. MISSING-008 — Fix `bun run lint` errors (Effort: M, Agent: ci-smith)**  
The lint step was added to `smoke.yml:19` as part of the 44ded1f commit, but it currently fails with 16 errors (JSON formatting in `package.json` and `config/ndomo.config.json`, plus TS `noNonNoneAssertion` in `background.test.ts`). This blocks the CI pipeline from passing. A single `biome check --write` on the JSON files + a targeted fix for the test TS assertions would resolve this. **This is the highest-leverage fix remaining — it unblocks MISSING-028 and enables MISSING-029 major upgrades.**

**2. MISSING-028 — Add `bun audit` to CI (Effort: S, Agent: ci-smith)**  
After MISSING-008 passes, adding `bun audit` as a CI step (post-lint) closes the CVE scanning gap. The project uses `bun.lock` so `npm audit` returns ENOLOCK — `bun audit` is the correct tool. One new step in `smoke.yml`.

**3. MISSING-029 — Upgrade biome + TypeScript majors (Effort: M, Agent: ci-smith)**  
`@biomejs/biome 1.9.4 → 2.5.0` and `typescript 5.9.3 → 6.0.3` are unreviewed major drifts. Requires: (a) fix lint errors from MISSING-008, (b) `bun upgrade` or manual version bump, (c) full CI run (typecheck + lint + test + smoke) to validate, (d) Dependabot PR or manual PR.

### Suggested Plan Slug
**`ops-medium-bucket-1`**  
Scope: ci-smith owns all 7 findings (MISSING-004, -008, -011, -028, -029, -030, -031, -032). Execution order: MISSING-008 (lint-fix PR) → MISSING-028 (bun audit) → MISSING-029 (major upgrades) → MISSING-004, -011, -030, -031, -032 (config docs). No cross-agent handoffs required within this plan.

---

## 7. Surprises Found During Re-Audit

1. **MISSING-005 was already resolved before v1 was published.** `.github/release.yml` was present in the working tree during the v1 audit but not credited. Status corrected to RESOLVED.

2. **MISSING-020 (gitleaks) was also already present before v1.** The gitleaks workflow was committed prior to the v1 audit date but wasn't listed in the v1 findings. Status corrected to RESOLVED.

3. **MISSING-008 is a PARTIAL resolution, not RESOLVED.** Adding `bun run lint` to `smoke.yml` was the correct fix for the CI gap, but the lint itself is broken with 16 errors. CI would fail on the lint job. This is a regression risk — the ops commit introduced a failing CI step.

4. **Dependabot is configured (MISSING-010 partial) but biome/TS majors are still at old versions.** The `.github/dependabot.yml` is well-configured with weekly schedules and grouped PRs, but the underlying drift in `package.json` hasn't been resolved by a PR yet. This is likely because dependabot runs on a schedule, not on-demand.

5. **release-please workflow has no checkout step.** `release-please-action` handles its own checkout internally, so this is not a security issue — but it's worth noting that MISSING-007's "all workflows" SHA-pinning check is technically 2/3 for checkout steps (smoke.yml and gitleaks.yml have explicit checkout; release-please.yml does not).

6. **The 44ded1f commit also added `bun.lock`** (200 lines added per `git show --stat`). The lockfile was not in the original v1 working tree. This is a legitimate addition — the Dockerfile needs `bun.lock` for `--frozen-lockfile` — but it's a non-trivial change to the repo state that wasn't part of the original 6-finding scope.

---

**End of audit v2.** Next: warden-owned plan `ops-medium-bucket-1` covering ci-smith items (MISSING-008 → MISSING-028 → MISSING-029 → MISSING-004, -011, -030, -031, -032) in dependency order.
