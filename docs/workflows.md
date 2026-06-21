# Workflow Guide

## Decision Tree

The first step for any user request is choosing the right agent. Use this decision tree:

```
User envía prompt
  │
  ├─ ¿Tarea ≤2 archivos, ≤50 líneas, bien definida?
  │   → craftsman (TUI) → Estado 1 (trivial, sin plan_db)
  │
  ├─ ¿Tarea 3-5 archivos, multi-stack, necesita tracking?
  │   → craftsman (TUI) → Estado 2 (ad-hoc con plan_db)
  │
  ├─ ¿Tarea >5 archivos, diseño de arquitectura, o ambigua?
  │   → foreman (TUI) → 4 pasos: Aclaración → Exploración → Plan → Persistir
  │   → craftsman (TUI) → Estado 3 (lee plan formal)
  │
  ├─ ¿Auditoría de PR existente o tarea read-only?
  │   → craftsman o scout según necesite escribir
  │
  └─ ¿Exploración read-only?
      → scout (TUI)
```

## Foreman Workflow (Planner, 4 pasos)

Para tareas >5 archivos o diseño de arquitectura. El foreman planifica y persiste en DB; no ejecuta.

```
User → Foreman (TUI)
  │
  Paso 1: Aclaración — identifica intención, pregunta si ambiguo
  Paso 2: Exploración — memory search + scout/scribe/sage/guild
  Paso 3: Plan Atómico — ≤5 steps con archivos y dependencias
  Paso 4: Persistir — plan_create + task_create_batch
  │
  → User cambia a craftsman en TUI ←
  │
  craftsman: Estado 3 — task_next_for_agent → implementa → plan_update_status("completed")
```

1. **Aclaración** — analiza intención en 1-2 frases. Si ambigüo, `question` al usuario. Si ≤5 archivos y bien definida → sugerir `craftsman` directamente.
2. **Exploración** — `memory({mode:"search"})` + delegar a scout/scribe/sage/guild según necesidad. NO delegar a smiths/painter/inspector/chronicler.
3. **Plan Atómico** — desglosar en ≤5 steps. Cada step: `(Acción) → archivos esperados [paths] → dependencias`. Estimar complejidad (1-5) y riesgo (low/medium/high).
4. **Persistir** — `plan_create` con slug/overview/approach. `task_create_batch` con steps (tasks asignadas a `craftsman`). **NO** crear `session_start` (lo hace craftsman). **NO** ejecutar tasks.

## Craftsman Workflow (Implementer, 4 estados)

Para tareas ≤5 archivos o para ejecutar planes formales del foreman.

### Estado 1: Trivial (≤2 archivos)
```
craftsman (TUI) → lee archivos → implementa → verifica → reporta
```
Sin writes a DB. Cambios directos.

### Estado 2: Multi-archivo acotado (3-5 archivos)
```
craftsman (TUI) → plan_create → task_create_batch → implementa por step → plan_update_status("completed")
```
Crea su propio plan en DB para trazabilidad cross-session.

### Estado 3: Plan formal (cualquier tamaño, plan pre-existente)
```
craftsman (TUI) → plan_get / task_next_for_agent → implementa tasks → plan_update_status("completed")
```
Ejecuta un plan que el foreman dejó en DB.

### Estado 4: Fuera de dominio (>5 archivos, sin plan)
```
[FUERA DE MI DOMINIO] → sugerir foreman → NO implementar
```

## Plan-Driven Workflow (ndomo DB)

Para trabajo multi-step trackeado cross-session. El foreman crea el plan en DB, craftsman lo ejecuta.

Ejemplo (foreman → craftsman):

```bash
# === Foreman ===
# 1. Crear plan en DB
plan_create id="p1" slug="add-user-auth" title="Add user authentication" \
  priority=2 overview="JWT-based auth for /api/* endpoints" \
  approach="1) schema migration 2) login route 3) middleware 4) tests" \
  complexity=4

# 2. Aprobar plan
plan_approve id="p1"

# 3. Crear tasks (asignadas a craftsman)
task_create_batch planId="p1" tasks='[
  {"agent":"craftsman","description":"design schema migration","files":["src/db/schema.ts"],"complexity":3},
  {"agent":"craftsman","description":"implement POST /login route","complexity":4,"dependencies":[0]},
  {"agent":"craftsman","description":"add JWT middleware","complexity":3,"dependencies":[1]},
  {"agent":"craftsman","description":"audit auth code with inspector","complexity":2,"dependencies":[1,2]}
]'

# === User cambia a craftsman en TUI ===

# === Craftsman ===
# 4. Tomar siguiente task
task_next_for_agent({agent: "craftsman", planId: "p1"})

# 5. Para cada task:
task_update_status(id="t1", status="running")
# ... implementa ...
task_update_status(id="t1", status="done", result="...")

# 6. Todas completadas:
plan_update_status(id="p1", status="completed")
# → auto-archives a .ndomo/archives/plans/add-user-auth-2026-06-19.md

session_end(id="s1")
```

Ver [docs/database.md](docs/database.md) para referencia completa de tools y
[agents/foreman.md](../agents/foreman.md) para el flujo detallado del foreman.

## T3 Unified Close Flow

The `plan_update_status` tool now includes readiness checks before closing a plan.
This prevents premature closures and gives agents visibility into blockers.

### Pre-check with dryRun

```bash
# 1. Pre-check — see blockers without mutating
plan_update_status(id="p1", status="completed", dryRun=true)
# → { blocked: true, blockers: ["tasks_pending", "sessions_open"], warnings: [] }

# 2. Fix blockers (complete pending tasks, close sessions)
task_update_status(id="t3", status="done", result="...")
session_end(id="s1")

# 3. Re-check — should be clear now
plan_update_status(id="p1", status="completed", dryRun=true)
# → { blocked: false, blockers: [], warnings: [] }

# 4. Actually close
plan_update_status(id="p1", status="completed")
```

### Force close with reason

When blockers can't be resolved (e.g., abandoned work), force-close with a reason:

```bash
plan_update_status(id="p1", status="abandoned", force=true, forceReason="scope changed, pivoting to new approach")
# → { forced: true, auditId: 42 }
```

The force action is captured in `plan_audit` for traceability. `status_invalid` blockers
cannot be force-bypassed.

### Blockers reference

| Blocker | Meaning |
|---|---|
| `tasks_pending` | Plan has tasks with `status='pending'` |
| `tasks_running` | Plan has tasks with `status='running'` |
| `sessions_open` | Plan has sessions without `ended_at` |
| `status_invalid` | Transition not allowed by state machine |

## Auto-Checkpoint Behavior

The plugin automatically captures orchestrator state into session checkpoints
on configurable triggers. This provides continuity across context compactions
and agent dispatches without manual `session_checkpoint` calls.

### Triggers

| Trigger | Fires when |
|---|---|
| `phase_transition` | `plan_update_status` succeeds (status actually changed, not dryRun) |
| `task_batch_complete` | Last pending task in a plan is marked `done` |

### Configuration (`ndomo.json`)

```json
{
  "autoCheckpoint": {
    "enabled": true,
    "triggers": ["phase_transition", "task_batch_complete"],
    "minIntervalMs": 30000,
    "captureState": {
      "completedTasks": true,
      "currentPhase": true,
      "blockers": true
    }
  }
}
```

- `enabled` — master switch (default: `true`)
- `triggers` — which triggers are active (default: both)
- `minIntervalMs` — debounce interval in ms (default: 30000)
- `captureState` — which state fields to capture (default: all `true`)

### Behavior

- **Non-blocking**: checkpoints are dispatched asynchronously via microtask — never blocks the tool executor.
- **Debounced**: rapid state changes produce at most one checkpoint per `minIntervalMs`.
- **Loop-safe**: an `isAutoCheckpointing` guard flag prevents re-entrant dispatch.
  Since `checkpointSession` only writes to the sessions table (not plans/tasks),
  loops are structurally impossible — the flag is a safety net.
- **Graceful**: errors in auto-checkpoint are swallowed (logged via `console.error`) — never break the caller.

### Captured state

```json
{
  "trigger": "phase_transition",
  "completedTasks": 5,
  "currentPhase": "executing",
  "blockers": ["tasks_pending"]
}
```

## Dependency-Aware Task Dispatch

`task_next_for_agent` now respects task dependencies. A task is only eligible
for claiming when all its dependencies (referenced by task ID) have `status='done'`.

```bash
# Tasks: t1 (no deps), t2 (depends on t1), t3 (depends on t1)
task_next_for_agent(agent="craftsman", planId="p1")
# → claims t1 (no deps)

# After t1 is done:
task_next_for_agent(agent="craftsman", planId="p1")
# → claims t2 or t3 (both have t1 done)
```

Use `task_dependency_resolver` to inspect a task's dependency state before claiming:

```bash
task_dependency_resolver(taskId="t2")
# → { canStart: true, doneDeps: ["t1"], pendingDeps: [], ... }
```

## Deepwork

**When to use:** Multi-file refactors (> 5 files), risky architecture changes (database schema, auth flow, API contracts), phased features with inter-step dependencies, cross-stack work.

Use `deepwork <task description>` to invoke. The workflow:

1. **Plan creation** — foreman creates `.slim/deepwork/<slug>.md` with phases, expected files, dependencies, and risk levels.
2. **Phase breakdown** — each phase is a discrete step with clear entry/exit criteria.
3. **Sage gates** — after each phase, `sage` reviews the result. If the gate fails, the plan is adjusted before proceeding.
4. **Worktree isolation** — deepwork auto-creates a git worktree at `.slim/worktrees/<slug>/` for isolation.
5. **Progress tracking** — the plan file is updated after each phase. Work can be resumed after context loss.
6. **Completion** — after all phases pass sage gates, the foreman requests user confirmation before merging the worktree.

## Worktrees

**When to use:** Risky changes that might break the main working tree, parallel development, experimental features, deepwork sessions.

Created by the foreman or on explicit request: "create a worktree for <task>".

### Lifecycle

```
Create → Work in isolation → User confirms merge → Merge → Cleanup
```

1. **Create** — `createWorktree(rootDir, slug, branch, agent?, description?)` creates a git worktree at `.slim/worktrees/<slug>/`.
2. **Isolate** — specialists are dispatched inside the worktree for file isolation.
3. **Track state** — persists state in `.slim/worktrees.json` via `loadState()` / `saveState()`.
4. **Integrity** — `verifyIntegrity()` checks directory existence, branch validity, and git registration.
5. **Merge** — user confirms explicitly before merging to main.
6. **Cleanup** — `cleanup()` removes abandoned/merged worktrees older than maxAge (default 7 days).

### Safety protocols

- `assertSafeName()` prevents shell injection in slug/branch parameters (alphanumeric, hyphens, underscores, slashes only; no leading hyphen).
- Foreman requires explicit user confirmation before merging any worktree.
- Integrity checks run on all active worktrees.

## Reflect

**When to use:** After 3+ similar tasks, repeated friction in workflows, or on user request.

Invoke: `reflect [optional focus]`

The workflow:

1. **Search memory** — scribe searches recent work for friction patterns and repeated errors.
2. **Analyze** — identify the root cause of repetitive friction.
3. **Propose fix** — suggest the smallest useful change: a new skill, command, agent, or config rule.
4. **Implement** — with user approval, create the fix.

Not for: one-off tasks or well-understood patterns with no friction.

## Background Dispatch

The `BackgroundDispatcher` class (`src/orchestrator/background.ts`) provides pure state tracking:

1. **dispatch** — registers a new task (`pending` status), returns a task ID.
2. **markRunning** — transitions to `running` with a session ID and timestamp.
3. **getActive** — returns all pending or running tasks.
4. **markComplete / markFailed** — transitions to terminal state with result or error.
5. **reconcile** — collects all finished tasks for processing.
6. **remove** — cleans up after reconciliation.

### No write overlap rule

Two agents editing the same file simultaneously is forbidden. Before dispatching a writer, the foreman checks that no active task claims those files. This is enforced at the scheduling level — the `canRunParallel()` function checks for file conflicts and dependency chains.

### Parallel dispatch rules

- Tasks with no explicit file list are assumed non-conflicting.
- Tasks with `parallel: false` (guild, sage debug) block the batch.
- If task A depends on task B (via `dependencies`), they cannot run in parallel.

## Memory Integration

The foreman runs the following memory protocol on every request:

1. **Before planning** — `memory({mode:"search", scope:"project"})` for current project context; `memory({mode:"search", scope:"all-projects"})` for cross-project knowledge.
2. **Before storing** — compress content to caveman format using `cavemanCompress()`.
3. **Compression rules** — drops articles, filler words, leading conjunctions, filler phrases. Preserves code blocks and URLs.
4. **Threshold** — `shouldStoreMemory()` filters out content < 20 chars or purely code blocks.
5. **Protected** — memory tool outputs are never pruned from context (listed in `protectedTools`).

The `memory-hook.ts` module provides `cavemanCompress()`, `prepareForMemory()`, and `shouldStoreMemory()` — all regex-based (zero LLM tokens).

## Smoke Tests (Checklist)

Verificación manual de los flujos primarios post-refactor. No requiere DB real — validar contra código y prompts.

### (a) Foreman flow 4 pasos

- [ ] **Aclaración:** foreman identifica intención en 1-2 frases (`agents/foreman.md:123-128`)
- [ ] **Aclaración:** si ≤5 archivos y bien definida → sugiere craftsman en lugar de planificar (`agents/foreman.md:126`)
- [ ] **Aclaración:** si >5 archivos o diseño arquitectura → continúa planificación
- [ ] **Exploración:** invoca `memory({mode:"search"})` antes de delegar (`agents/foreman.md:130-131`)
- [ ] **Exploración:** delega solo a scout/scribe/sage/guild (`agents/foreman.md:133-136`)
- [ ] **Exploración:** NO delega a smiths/painter/chronicler/inspector (`agents/foreman.md:138`)
- [ ] **Plan Atómico:** desglosa en ≤5 steps con archivos y dependencias (`agents/foreman.md:140-144`)
- [ ] **Persistir:** llama `plan_create` + `task_create_batch` con tasks para craftsman (`agents/foreman.md:147-151`)
- [ ] **Persistir:** NO crea `session_start` (lo hace craftsman al ejecutar) (`agents/foreman.md:149`)
- [ ] **Routing table:** foreman solo lista scout/scribe/sage/guild (`agents/foreman.md:45-51`)
- [ ] **Salida:** formato caveman con objetivo/exploración/plan/persistido/siguiente (`agents/foreman.md:155-164`)

### (b) Craftsman Estado 1 (trivial, ≤2 archivos)

- [ ] Detecta ≤2 archivos sin dependencias externas (`agents/craftsman.md:58`)
- [ ] Implementa sin `plan_create` ni writes a DB (`agents/craftsman.md:67`)
- [ ] Corre validación (typecheck/tests/lint) (`agents/craftsman.md:63`)
- [ ] Reporta en formato caveman: archivos, líneas, verificación (`agents/craftsman.md:200-217`)
- [ ] NO toca `plan_db` tools (`agents/craftsman.md:67`)

### (c) Craftsman Estado 4 (rechazo >5 archivos)

- [ ] Detecta >5 archivos o requiere diseño de arquitectura (`agents/craftsman.md:121`)
- [ ] Reporta `[FUERA DE MI DOMINIO]` con razón (`agents/craftsman.md:124`)
- [ ] Sugiere cambiar a foreman en TUI (`agents/craftsman.md:125`)
- [ ] NO implementa parcialmente — rechaza completo (`agents/craftsman.md:126`, `agents/craftsman.md:193`)
- [ ] Output format: resultado/razon/sugerencia (`agents/craftsman.md:220-224`)

## Tools by agent

### Craftsman

| Mode | Tools used |
|---|---|
| AD-HOC (Estado 1) | `task_update_status` (result/error only), `session_start`/`session_end` |
| PLAN (Estado 2) | `plan_create`, `task_create_batch`, `task_update_status`, `task_next_for_agent`, `task_add_artifact`, `task_review`, `plan_progress`, `plan_files_write`, `session_start`/`session_end` |
| DISPATCHED (Estado 3) | `task_next_for_agent`, `task_update_status` (with artifacts/metadataPatch), `task_add_artifact`, `task_review`, `task_peek_for_agent`, `plan_progress`, `session_start`/`session_end` |

- `task_peek_for_agent` — read-only check before claiming (no status change).
- `task_add_artifact` — register output files after implementation.
- `task_review` — inspector reviews done tasks, sets verdict.
- `plan_progress` — monitor plan progress during execution.
- `plan_files_write` — register input/modified/output files for a plan.

### Warden

| Mode | Tools used |
|---|---|
| AD-HOC | `task_update_status`, `session_start`/`session_end` |
| PLAN | `plan_create` (metadata.category="ops"), `task_create_batch`, `task_update_status`, `task_review`, `plan_progress`, `incident_create`, `rollback_record`, `session_start`/`session_end` |
| DISPATCHED | `task_next_for_agent`, `task_update_status`, `task_review`, `plan_progress`, `incident_create`, `rollback_record` |

- `incident_create` — register an ops incident (sev1-4) when a deployment fails or issue detected.
- `rollback_record` — record a rollback execution tied to a deployment (required) + optional incident.

### Foreman

| Mode | Tools used |
|---|---|
| Planning | `plan_create`, `task_create_batch`, `plan_get`, `plan_list`, `plan_search`, `plan_approve`, `plan_update_status`, `plan_progress`, `session_start`/`session_end` |
| Dispatch | `task_create_batch` (agent="craftsman"/"warden"), `task_next_for_agent` (check), `plan_progress` (monitor) |

- Foreman does NOT use `task_update_status` (delegates execution to craftsman/warden).
- Foreman does NOT use `task_add_artifact` or `task_review` (those are post-execution tools).

## Warden ops workflow — incident response

The 3-call flow for incident response (warden scope):

```
1. Detect failure (deployment status='failed' or external alert)
   │
2. incident_create(title, severity, summary, triggeredByDeploymentId?)
   → Returns Incident record with status='open'
   │
3. rollback_record(deploymentId, plan, incidentId, status='planned')
   → Returns RollbackExecution record
   → Optional: update status to 'executing' → 'success'/'failed' as rollback progresses
```

### Integration with warden workflow

This flow fits into the warden's existing incident response pattern (`agents/warden.md`):

1. **Detect** — warden monitors deployments (via `plan_progress` or external alerts).
2. **Triage** — `incident_create` with severity sev1-4. Status starts as `open`.
   - Use `triggeredByDeploymentId` to link the incident to the failing deployment.
3. **Rollback** — `rollback_record` with the deployment_id (required) + incident_id (optional but recommended).
   - The `plan` field describes the rollback strategy (e.g. "redeploy previous release v1.2.3").
   - Status transitions: `planned` → `approved` → `dry_run` → `executing` → `success`/`failed`.
4. **Resolve** — update incident status to `mitigated` then `resolved` (via `updateIncidentStatus` DB helper).
   - Optional: `postmortem` status for retrospective.

### Example (3-call flow)

```typescript
// 1. Detect: deployment d_abc123 failed
// 2. Create incident
incident_create({
  title: "prod deployment v2.1.0 failed — auth service 500s",
  severity: "sev1",
  summary: "Deployment d_abc123 caused auth service to return 500 errors. ~30% of users affected.",
  triggeredByDeploymentId: "d_abc123",
})

// 3. Record rollback plan
rollback_record({
  deploymentId: "d_abc123",
  plan: "Redeploy previous release v2.0.3. Steps: 1) mark d_abc123 as rolled_back, 2) create new deployment for v2.0.3 to prod, 3) verify auth service health.",
  incidentId: "inc_xyz789",
  status: "planned",
})
```
